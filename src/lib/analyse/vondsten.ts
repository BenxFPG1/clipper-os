import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../supabase';
import { downloadVideo, probeDuur } from '../roughcut/frames';
import { accountSleutel, herberekenNormen } from '../vault/normen';
import { kiesBasislijn, meetAccount } from '../agents/scout';
import { getFallbackProvider, getMetricsProvider, type MetricsProvider, type Platform } from '../tracking/provider';
import { logProviderUsage } from '../supabase';
import { MAX_SHORTFORM_S, VINGERAFDRUK_VERSIE, vingerafdrukVanBestand, type Vingerafdruk } from './vingerafdruk';

/**
 * Meet externe vondsten (scout_finds) en bewaart hun vingerafdruk: de
 * sterkste uitschieters én evenveel gewone basislijnposts, zodat de
 * aggregatie in normen.ts top tegen basis kan zetten.
 */

/** Na zoveel mislukte pogingen (verwijderde post, geoblokt) slaan we een vondst over. */
const MAX_POGINGEN = 3;

/**
 * Alleen short-form meten. Tussen de "vondsten" staan ook TikToks van acht
 * tot tien minuten (eerste echte run: 489 s en 589 s); die hebben een heel
 * ander ritme, vertekenen elke norm voor korte clips en kostten elk minuten
 * aan transcriptie. Zo'n vondst krijgt een definitieve foutmarker.
 */
const MAX_DUUR_S = MAX_SHORTFORM_S;

class DefinitieveFout extends Error {}

type Vondst = { id: string; post_url: string; handle: string | null; platform: string; tracked_account_id: string | null; is_basislijn: boolean };

export type MeetFout = { versie: number; fout: string; pogingen: number; gemeten_at: string };

/** Bruikbaar = een echte meting, geen foutmarker. */
export function isMeting(x: unknown): x is Vingerafdruk {
  return Boolean(x && typeof x === 'object' && typeof (x as Vingerafdruk).duurS === 'number');
}

/**
 * Meet één vondst. Met `bestand` hergebruikt hij een download die de
 * aanroeper al had (kijken, editleraar_visueel); anders downloadt hij zelf
 * en ruimt hij daarna op. Een mislukte meting wordt als foutmarker bewaard
 * (met de echte oorzaak), zodat een dode link niet elke dag bovenaan de
 * wachtrij blijft staan.
 */
export async function meetEnBewaarVondst(
  vondst: { id: string; post_url: string },
  opties: { bestand?: string; visueel?: boolean; transcriberen?: boolean; vorigePogingen?: number } = {},
): Promise<Vingerafdruk> {
  let map: string | null = null;
  try {
    let pad = opties.bestand;
    if (!pad) {
      map = await mkdtemp(join(tmpdir(), 'clipper-vinger-dl-'));
      pad = join(map, 'bron.mp4');
      await downloadVideo(vondst.post_url, pad);
    }
    const duur = await probeDuur(pad);
    if (duur !== null && duur > MAX_DUUR_S) {
      throw new DefinitieveFout(`te lang voor short-form (${Math.round(duur)} s > ${MAX_DUUR_S} s), niet gemeten`);
    }
    const v = await vingerafdrukVanBestand(pad, { visueel: opties.visueel, transcriberen: opties.transcriberen });
    const { error } = await db().from('scout_finds').update({ vingerafdruk: v }).eq('id', vondst.id);
    if (error) throw new Error(`opslaan: ${error.message}`);
    return v;
  } catch (e) {
    const fout: MeetFout = {
      versie: VINGERAFDRUK_VERSIE,
      fout: ((e as Error).message ?? String(e)).slice(0, 400),
      pogingen: e instanceof DefinitieveFout ? MAX_POGINGEN : (opties.vorigePogingen ?? 0) + 1,
      gemeten_at: new Date().toISOString(),
    };
    await db().from('scout_finds').update({ vingerafdruk: fout }).eq('id', vondst.id);
    throw e;
  } finally {
    if (map) await rm(map, { recursive: true, force: true });
  }
}

/**
 * Kort, leesbaar, voor in de prompt van de kijk-passen: dan hoeft het model
 * ritme en tekst-in-beeld niet uit tien stilstaande frames te raden — het is
 * gemeten.
 */
export function vingerafdrukSamenvatting(v: unknown): string | null {
  if (!isMeting(v)) return null;
  const d = (n: number | null | undefined, s = '') => (n === null || n === undefined ? '—' : `${String(Math.round(n * 10) / 10).replace('.', ',')}${s}`);
  const regels = [
    `duur ${d(v.duurS, ' s')}; ${v.aantalWissels} visuele wissels (${d(v.wisselsPer10s)} per 10 s, ${v.wisselsEerste3s} in de eerste 3 s); eerste wissel op ${d(v.eersteWisselS, ' s')}; langste stuk zonder wissel ${d(v.langsteZonderWisselS, ' s')}`,
    `spraak start op ${d(v.spraakStartS, ' s')}; ${v.pauzesAantal} pauzes >0,4 s; tempo ${d(v.woordenPerS, ' woorden/s')}; loudness ${d(v.loudnessI, ' LUFS')}`,
  ];
  if (v.visueel) {
    regels.push(
      `tekst in beeld ~${Math.round(v.visueel.tekstInBeeldAandeel * 100)}% van de tijd (ondertitels: ${v.visueel.ondertitelstijl}, ${v.visueel.ondertitel_positie}); kader meestal ${v.visueel.kader}; b-roll: ${v.visueel.broll ? 'ja' : 'nee'}`,
    );
  }
  return regels.join('\n');
}

export type VingerafdrukRun = {
  gemeten: { top: number; basis: number };
  fouten: { post_url: string; handle: string | null; fout: string }[];
  voorbeeld: Vingerafdruk | null;
  normen: Awaited<ReturnType<typeof herberekenNormen>> | null;
  normFout: string | null;
  gestoptOpTijd: boolean;
  agentRunId: string | null;
};

/**
 * De dagelijkse job: sterkste nog-niet-gemeten top-vondsten + evenveel
 * basislijnposts meten, dan de normen herberekenen.
 *
 * Om en om top en basis: stopt de run op het tijdsbudget, dan zijn beide
 * groepen ongeveer even groot gegroeid in plaats van alleen de tops.
 */
export async function runVingerafdrukJob(
  opties: { batch?: number; maxMinuten?: number; visueel?: boolean; alleenAggregatie?: boolean } = {},
): Promise<VingerafdrukRun> {
  const batch = opties.batch ?? Number(process.env.VINGERAFDRUK_BATCH ?? 15);
  const maxMs = (opties.maxMinuten ?? Number(process.env.VINGERAFDRUK_MAX_MIN ?? 18)) * 60_000;
  const visueel = opties.visueel ?? process.env.VINGERAFDRUK_VISUEEL !== '0';
  const start = Date.now();
  const supabase = db();

  const alleenAggregatie = opties.alleenAggregatie ?? process.env.VINGERAFDRUK_ALLEEN_AGGREGATIE === '1';

  // De normen zijn gepaard (uitschieter vs gewone post van hetzelfde
  // account), dus elk account met maar één kant gemeten is verspilde meting.
  // Eerst de ontbrekende kant aanvullen, daarna pas nieuwe accounts.
  const stand = alleenAggregatie ? null : await gemetenStand();
  let basislijnAangevuld = 0;
  if (stand) {
    try {
      basislijnAangevuld = await vulOntbrekendeBasislijn(stand.alleenTop, Number(process.env.VINGERAFDRUK_MAX_AANVUL_ACCOUNTS ?? 8));
    } catch (e) {
      console.log(`  basislijn aanvullen mislukt: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  const nodigTop = stand ? stand.alleenBasis : new Set<string>();
  const nodigBasis = stand ? stand.alleenTop : new Set<string>();
  const heeftTop = stand ? stand.metTop : new Set<string>();
  const sleutel = (v: Vondst) => accountSleutel(v.post_url, v.tracked_account_id) ?? '';

  // Tops: eerst accounts die al een gemeten basislijn hebben maar nog geen
  // top; verder op outlier-score (volgorde van de query blijft staan).
  const tops = alleenAggregatie
    ? []
    : stabielSorteer(await kandidaten(false, batch * 4), (v) => (nodigTop.has(sleutel(v)) ? 0 : 1)).slice(0, batch);
  // Basislijn: eerst accounts met een gemeten top zonder basislijn, dan
  // accounts die sowieso al een top hebben (meer paren per account maakt de
  // mediaan per account stabieler), dan de rest.
  const basis = alleenAggregatie
    ? []
    : stabielSorteer(await kandidaten(true, batch * 6), (v) => (nodigBasis.has(sleutel(v)) ? 0 : heeftTop.has(sleutel(v)) ? 1 : 2)).slice(
        0,
        Math.max(batch, tops.length),
      );
  if (stand) {
    console.log(
      `  paren: ${stand.paren} accounts met beide soorten; ${stand.alleenTop.size} alleen top, ${stand.alleenBasis.size} alleen basis; ${basislijnAangevuld} basislijnpost(s) aangevuld`,
    );
  }

  const volgorde: (Vondst & { pogingen: number })[] = [];
  for (let i = 0; i < Math.max(tops.length, basis.length); i++) {
    if (tops[i]) volgorde.push(tops[i]);
    if (basis[i]) volgorde.push(basis[i]);
  }

  const run: VingerafdrukRun = { gemeten: { top: 0, basis: 0 }, fouten: [], voorbeeld: null, normen: null, normFout: null, gestoptOpTijd: false, agentRunId: null };
  for (const v of volgorde) {
    if (Date.now() - start > maxMs) {
      run.gestoptOpTijd = true;
      break;
    }
    try {
      const meting = await meetEnBewaarVondst(v, { visueel, vorigePogingen: v.pogingen });
      if (v.is_basislijn) run.gemeten.basis++;
      else run.gemeten.top++;
      if (!run.voorbeeld || (meting.visueel && !run.voorbeeld.visueel)) run.voorbeeld = meting;
      console.log(`  ✓ ${v.is_basislijn ? 'basis' : 'top  '} @${v.handle}: ${meting.aantalWissels} wissels, eerste ${meting.eersteWisselS}s${meting.opmerkingen.length ? ` (${meting.opmerkingen.join('; ').slice(0, 100)})` : ''}`);
    } catch (e) {
      const fout = ((e as Error).message ?? String(e)).replace(/\s+/g, ' ').slice(0, 300);
      run.fouten.push({ post_url: v.post_url, handle: v.handle, fout });
      console.log(`  ✗ ${v.is_basislijn ? 'basis' : 'top  '} @${v.handle}: ${fout.slice(0, 160)}`);
    }
  }

  // Ook zonder nieuwe metingen herberekenen: er kunnen eigen beoordelingen
  // bijgekomen zijn, en die tellen ook mee.
  try {
    run.normen = await herberekenNormen();
  } catch (e) {
    run.normFout = (e as Error).message;
  }

  const { data: rij } = await supabase
    .from('agent_runs')
    .insert({
      agent: 'vingerafdruk',
      status: 'auto',
      decided_by: 'auto',
      input_summary: {
        kandidaten: { top: tops.length, basis: basis.length },
        paren_voor: stand?.paren ?? null,
        basislijn_aangevuld: basislijnAangevuld,
        alleen_aggregatie: alleenAggregatie,
        gemeten: run.gemeten,
        fouten: run.fouten,
        gestopt_op_tijd: run.gestoptOpTijd,
        visueel,
      },
      proposal: { normen: run.normen?.rijen ?? [], waarschuwingen: run.normen?.waarschuwingen ?? [], norm_fout: run.normFout },
    })
    .select('id')
    .single();
  run.agentRunId = (rij?.id as string | undefined) ?? null;
  return run;
}

async function kandidaten(basislijn: boolean, aantal: number): Promise<(Vondst & { pogingen: number })[]> {
  const supabase = db();
  const velden = 'id, post_url, handle, platform, tracked_account_id, is_basislijn';
  let q = supabase.from('scout_finds').select(velden).eq('is_basislijn', basislijn).is('vingerafdruk', null).not('post_url', 'is', null);
  q = basislijn
    ? q.order('created_at', { ascending: false })
    : q.order('outlier_score', { ascending: false, nullsFirst: false });
  const { data, error } = await q.limit(aantal);
  if (error) throw new Error(`kandidaten lezen: ${error.message}`);
  const uit = (data ?? []).map((r) => ({ ...(r as Vondst), pogingen: 0 }));

  // Eerder mislukt maar nog niet opgegeven (tijdelijke fout, rate limit):
  // alleen als er ruimte over is — nieuwe vondsten gaan voor.
  if (uit.length < aantal) {
    const { data: opnieuw } = await supabase
      .from('scout_finds')
      .select(`${velden}, vingerafdruk`)
      .eq('is_basislijn', basislijn)
      .in('vingerafdruk->>pogingen', Array.from({ length: MAX_POGINGEN - 1 }, (_, i) => String(i + 1)))
      .limit(aantal - uit.length);
    for (const r of opnieuw ?? []) {
      uit.push({ ...(r as unknown as Vondst), pogingen: Number((r.vingerafdruk as MeetFout | null)?.pogingen ?? 1) });
    }
  }
  return uit;
}

function stabielSorteer<T>(xs: T[], prioriteit: (x: T) => number): T[] {
  return xs.map((x, i) => ({ x, i, p: prioriteit(x) })).sort((a, b) => a.p - b.p || a.i - b.i).map((y) => y.x);
}

/** Welke accounts hebben al een bruikbare top- en/of basislijnmeting. */
async function gemetenStand(): Promise<{ paren: number; metTop: Set<string>; alleenTop: Set<string>; alleenBasis: Set<string> }> {
  const metTop = new Set<string>();
  const metBasis = new Set<string>();
  for (let van = 0; ; van += 1000) {
    const { data, error } = await db()
      .from('scout_finds')
      .select('post_url, tracked_account_id, is_basislijn, duur:vingerafdruk->duurS')
      .not('vingerafdruk->duurS', 'is', null)
      .range(van, van + 999);
    if (error) throw new Error(`stand lezen: ${error.message}`);
    for (const r of data ?? []) {
      const duur = Number((r as { duur?: unknown }).duur);
      if (!Number.isFinite(duur) || duur > MAX_SHORTFORM_S) continue;
      const k = accountSleutel(r.post_url as string | null, r.tracked_account_id as string | null);
      if (k) (r.is_basislijn ? metBasis : metTop).add(k);
    }
    if (!data || data.length < 1000) break;
  }
  return {
    paren: [...metTop].filter((k) => metBasis.has(k)).length,
    metTop,
    alleenTop: new Set([...metTop].filter((k) => !metBasis.has(k))),
    alleenBasis: new Set([...metBasis].filter((k) => !metTop.has(k))),
  };
}

/**
 * Accounts met een gemeten top maar zonder enige basislijnrij (ook geen
 * ongemeten): die krijgt de scout nooit, bijvoorbeeld omdat de top uit een
 * zoekterm kwam en het account niet gevolgd wordt. Dan halen we hier zelf
 * hun recente posts op en bewaren we er twee rond de mediaan, precies zoals
 * de scout dat doet. Begrensd per run: elk account is één provider-call.
 */
async function vulOntbrekendeBasislijn(alleenTop: Set<string>, maxAccounts: number): Promise<number> {
  if (alleenTop.size === 0 || maxAccounts <= 0) return 0;
  const supabase = db();

  // Welke van die accounts hebben al ongemeten basislijnrijen? Die hoeven
  // niet opgehaald te worden: de meetvolgorde pakt ze vanzelf eerst.
  const { data: open } = await supabase
    .from('scout_finds')
    .select('post_url, tracked_account_id')
    .eq('is_basislijn', true)
    .is('vingerafdruk', null)
    .limit(2000);
  const heeftOpen = new Set((open ?? []).map((r) => accountSleutel(r.post_url as string, r.tracked_account_id as string | null)));

  // Handle, platform en thema per account uit een van zijn tops.
  const { data: tops } = await supabase
    .from('scout_finds')
    .select('post_url, platform, theme, tracked_account_id')
    .eq('is_basislijn', false)
    .not('vingerafdruk->duurS', 'is', null)
    .limit(2000);
  const doelen = new Map<string, { handle: string; platform: Platform; theme: string | null; accountId: string | null }>();
  for (const t of tops ?? []) {
    const k = accountSleutel(t.post_url as string, t.tracked_account_id as string | null);
    const handle = (t.post_url as string).match(/\/@([^/?#]+)/)?.[1];
    if (!k || !handle || !alleenTop.has(k) || heeftOpen.has(k) || doelen.has(k)) continue;
    doelen.set(k, { handle, platform: t.platform as Platform, theme: (t.theme as string | null) ?? null, accountId: (t.tracked_account_id as string | null) ?? null });
  }

  const provider = getMetricsProvider();
  const reserve = getFallbackProvider(provider);
  let bewaard = 0;
  for (const [k, d] of [...doelen].slice(0, maxAccounts)) {
    try {
      let gebruikt: MetricsProvider = provider;
      let posts;
      try {
        posts = await provider.fetchAccountPosts(d.handle, d.platform, 30);
      } catch (e) {
        if (!reserve) throw e;
        gebruikt = reserve;
        posts = await reserve.fetchAccountPosts(d.handle, d.platform, 30);
      }
      await logProviderUsage(gebruikt.name, 'fetch_account_posts', 1, gebruikt.costPerCallEur).catch(() => undefined);
      const meting = meetAccount(posts);
      if (!meting) {
        console.log(`  basislijn @${d.handle}: te weinig posts of mediaan buiten bereik — overgeslagen`);
        continue;
      }
      const rijen = kiesBasislijn(meting.recent, meting.mediaan).map((p) => ({
        tracked_account_id: d.accountId,
        handle: d.handle,
        platform: d.platform,
        post_url: p.post_url,
        posted_at: p.posted_at,
        views: p.views,
        likes: p.likes,
        comments: p.comments,
        outlier_score: Math.round((p.views! / meting.mediaan) * 100) / 100,
        gevonden_via: `basislijn:@${d.handle}`,
        theme: d.theme,
        caption: p.caption,
        is_basislijn: true,
      }));
      if (rijen.length === 0) continue;
      const { error } = await supabase.from('scout_finds').upsert(rijen, { onConflict: 'post_url', ignoreDuplicates: true });
      if (error) throw new Error(error.message);
      bewaard += rijen.length;
      console.log(`  basislijn @${d.handle} (${k}): ${rijen.length} gewone post(s) rond mediaan ${Math.round(meting.mediaan)}`);
    } catch (e) {
      console.log(`  basislijn @${d.handle}: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  return bewaard;
}
