import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../supabase';
import { downloadVideo, probeDuur } from '../roughcut/frames';
import { herberekenNormen } from '../vault/normen';
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
export async function runVingerafdrukJob(opties: { batch?: number; maxMinuten?: number; visueel?: boolean } = {}): Promise<VingerafdrukRun> {
  const batch = opties.batch ?? Number(process.env.VINGERAFDRUK_BATCH ?? 15);
  const maxMs = (opties.maxMinuten ?? Number(process.env.VINGERAFDRUK_MAX_MIN ?? 18)) * 60_000;
  const visueel = opties.visueel ?? process.env.VINGERAFDRUK_VISUEEL !== '0';
  const start = Date.now();
  const supabase = db();

  const tops = await kandidaten(false, batch);
  const topAccounts = new Set(tops.map((t) => t.tracked_account_id).filter(Boolean));
  // Basislijn bij voorkeur van dezelfde accounts: dan is het verschil echt
  // "uitschieter vs gewone dag van dezelfde maker", niet "ander account".
  const basis = (await kandidaten(true, batch * 4))
    .sort((a, b) => Number(topAccounts.has(b.tracked_account_id)) - Number(topAccounts.has(a.tracked_account_id)))
    .slice(0, Math.max(batch, tops.length));

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
