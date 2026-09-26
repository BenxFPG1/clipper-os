import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { structuredCall } from '../claude';
import { AGENT_EFFORT } from '../env';
import { r2Download } from '../r2';
import { db, one } from '../supabase';
import { bewaarKennis, type KennisCategorie } from '../vault/kennis';
import { editDoelen, editNormenVoorPrompt, type EditDoelen } from '../vault/normen';
import {
  clipNummerUitNaam,
  hookVariantVan,
  planInfo,
  planVoorRender,
  type Oordeel,
  type RenderBestand,
  type RenderJobRij,
} from '../tracking/leerlus';

/**
 * Smaak-agent: leert van ons eigen oordeel over renders (goed / matig / weg +
 * één zin waarom) en van de cijfers van wat we zelf postten, naast wat de
 * externe normen en trends zeggen. Waar de retro gewichten verschuift, zet deze
 * agent concrete montage- en verhaallessen in de kennisvault — met erbij of het
 * eigen smaak is, eigen cijfers, of bevestigd door externe data.
 *
 * Streng begrensd: pas bij genoeg nieuwe oordelen, hooguit drie lessen per run,
 * en alleen patronen die bij minstens drie renders terugkomen. Eén clip die je
 * niet mooi vond is een mening, drie is een patroon.
 */

export const MIN_NIEUWE_BEOORDELINGEN = 5;
export const MAX_LESSEN = 3;
export const MIN_RENDERS_PER_LES = 3;
/** Per run hooguit zoveel bestanden vingerafdrukken: elk kost een download en een ffmpeg-pass. */
export const VINGERAFDRUK_PER_RUN = 10;

/* ------------------------------------------------------------ vingerafdruk */

type VingerafdrukFn = (pad: string, opties?: Record<string, unknown>) => Promise<unknown>;

/**
 * De vingerafdruk-module komt uit een ander spoor en bestaat misschien nog
 * niet. Dynamisch importeren met een variabele specifier: dan struikelen tsc
 * en de Next-build er niet over, en ontbreekt hij, dan slaan we over met een
 * logregel in plaats van te crashen.
 */
export async function laadVingerafdruk(): Promise<VingerafdrukFn | null> {
  const specifier = '../analyse/vingerafdruk';
  try {
    const mod = (await import(/* webpackIgnore: true */ specifier)) as { vingerafdrukVanBestand?: unknown };
    if (typeof mod.vingerafdrukVanBestand !== 'function') {
      console.log('  vingerafdruk: module gevonden maar zonder vingerafdrukVanBestand — overgeslagen');
      return null;
    }
    return mod.vingerafdrukVanBestand as VingerafdrukFn;
  } catch (e) {
    console.log(`  vingerafdruk: module src/lib/analyse/vingerafdruk nog niet beschikbaar — overgeslagen (${(e as Error).message.slice(0, 80)})`);
    return null;
  }
}

/** Haalt een render-bestand uit R2 naar een tijdelijke map. Opruimen doet de aanroeper (map teruggegeven). */
export async function downloadRender(pad: string): Promise<{ map: string; bestand: string }> {
  const map = await mkdtemp(join(tmpdir(), 'clipper-render-'));
  const { data, error } = await r2Download(pad);
  if (error || !data) {
    await rm(map, { recursive: true, force: true });
    throw new Error(`Download uit R2 mislukt: ${error?.message ?? 'leeg'}`);
  }
  const bestand = join(map, 'render.mp4');
  await writeFile(bestand, Buffer.from(await data.arrayBuffer()));
  return { map, bestand };
}

/**
 * Maakt eigen renders meetbaar: voor klare renders zonder vingerafdruk het
 * mp4 uit R2 halen, de vingerafdruk (met visuele analyse) draaien en het
 * resultaat bij het bestand in render_jobs.bestanden zetten. Beoordeelde en
 * geposte renders eerst — daar hebben we een oordeel of cijfers tegenover —
 * en de hoofdversie vóór de hookvarianten (die delen de montage).
 */
export async function runRenderVingerafdruk(limiet = VINGERAFDRUK_PER_RUN): Promise<{
  gedaan: number;
  mislukt: number;
  open: number;
  overgeslagen: string | null;
}> {
  const supabase = db();
  const { data: jobs, error } = await supabase
    .from('render_jobs')
    .select('id, video_id, clip_index, titel, status, bestanden, created_at, gestart_at, klaar_at')
    .eq('status', 'klaar')
    .order('klaar_at', { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) throw new Error(error.message);

  const [oordelen, gepost] = await Promise.all([
    supabase.from('render_beoordelingen').select('render_job_id, bestand_naam'),
    supabase.from('clips').select('render_job_id, render_bestand').not('render_job_id', 'is', null),
  ]);
  const beoordeeld = new Set((oordelen.data ?? []).map((o) => `${o.render_job_id}|${o.bestand_naam}`));
  const geposteSet = new Set((gepost.data ?? []).map((c) => `${c.render_job_id}|${c.render_bestand}`));

  const kandidaten: { job: RenderJobRij; bestand: RenderBestand; prio: number; volgorde: number }[] = [];
  let volgorde = 0;
  for (const job of (jobs ?? []) as RenderJobRij[]) {
    for (const b of job.bestanden ?? []) {
      if (b.vingerafdruk || b.vingerafdruk_fout) continue;
      const k = `${job.id}|${b.naam}`;
      const prio = (geposteSet.has(k) ? 4 : 0) + (beoordeeld.has(k) ? 2 : 0) + (hookVariantVan(b) === 1 ? 1 : 0);
      kandidaten.push({ job, bestand: b, prio, volgorde: volgorde++ });
    }
  }
  kandidaten.sort((a, b) => b.prio - a.prio || a.volgorde - b.volgorde);
  if (kandidaten.length === 0) return { gedaan: 0, mislukt: 0, open: 0, overgeslagen: 'alle klare renders hebben al een vingerafdruk' };

  const vingerafdruk = await laadVingerafdruk();
  if (!vingerafdruk) return { gedaan: 0, mislukt: 0, open: kandidaten.length, overgeslagen: 'vingerafdruk-module ontbreekt nog' };

  let gedaan = 0;
  let mislukt = 0;
  for (const { job, bestand } of kandidaten.slice(0, limiet)) {
    let resultaat: unknown = null;
    let fout: string | null = null;
    let map: string | null = null;
    try {
      const dl = await downloadRender(bestand.pad);
      map = dl.map;
      resultaat = await vingerafdruk(dl.bestand, { visueel: true });
    } catch (e) {
      fout = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    } finally {
      if (map) await rm(map, { recursive: true, force: true });
    }

    // Opnieuw lezen vlak voor het schrijven: de bestandenlijst is gedeeld met
    // de worker, en we willen alleen ons eigen veld aanraken.
    const { data: vers } = await supabase.from('render_jobs').select('bestanden').eq('id', job.id).single();
    const bestanden = ((vers?.bestanden ?? []) as RenderBestand[]).map((b) =>
      b.naam === bestand.naam
        ? fout
          ? { ...b, vingerafdruk_fout: fout }
          : { ...b, vingerafdruk: resultaat, vingerafdruk_fout: undefined }
        : b,
    );
    await supabase.from('render_jobs').update({ bestanden }).eq('id', job.id);
    if (fout) {
      mislukt++;
      console.log(`  mislukt: ${bestand.naam} — ${fout.slice(0, 120)}`);
    } else {
      gedaan++;
      console.log(`  + ${bestand.naam}`);
    }
  }
  return { gedaan, mislukt, open: Math.max(0, kandidaten.length - limiet), overgeslagen: null };
}

/* ----------------------------------------------- vingerafdruk vs edit-doelen */

/**
 * Per doel: onder welke naam het kenmerk in een vingerafdruk staat (eerst de
 * namen uit src/lib/analyse/vingerafdruk.ts, dan varianten), en of lager of
 * hoger beter is. maxPauzeS heeft geen één-op-één kenmerk (de vingerafdruk
 * telt pauzes, meet niet de langste) en valt dus weg tot die er is.
 */
const DOEL_KENMERKEN: { doel: keyof Omit<EditDoelen, 'bron' | 'n'>; namen: string[]; beter: 'lager' | 'hoger' }[] = [
  { doel: 'eersteKnipMaxS', namen: ['eersteWisselS', 'eersteKnipS', 'eersteKnipMaxS'], beter: 'lager' },
  { doel: 'knippenPer10s', namen: ['wisselsPer10s', 'knippenPer10s'], beter: 'hoger' },
  {
    doel: 'maxSecondenZonderVisueleVerandering',
    namen: ['langsteZonderWisselS', 'maxSecondenZonderVisueleVerandering'],
    beter: 'lager',
  },
  { doel: 'maxSecondenZonderTekst', namen: ['langsteZonderTekstS', 'maxSecondenZonderTekst'], beter: 'lager' },
  { doel: 'maxPauzeS', namen: ['langstePauzeS', 'maxPauzeS'], beter: 'lager' },
  { doel: 'tekstInBeeldAandeel', namen: ['tekstInBeeldAandeel'], beter: 'hoger' },
  { doel: 'wisselsEerste3sMin', namen: ['wisselsEerste3s', 'wisselsEerste3sMin'], beter: 'hoger' },
  { doel: 'spraakStartMaxS', namen: ['spraakStartS', 'spraakStartMaxS'], beter: 'lager' },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Alle getallen in een vingerafdruk (tot twee niveaus diep), op genormaliseerde naam. */
export function getallenUit(v: unknown): Map<string, number> {
  const uit = new Map<string, number>();
  const loop = (o: unknown, diepte: number) => {
    if (!o || typeof o !== 'object' || Array.isArray(o) || diepte > 2) return;
    for (const [k, w] of Object.entries(o as Record<string, unknown>)) {
      if (typeof w === 'number' && Number.isFinite(w)) {
        if (!uit.has(norm(k))) uit.set(norm(k), w);
      } else loop(w, diepte + 1);
    }
  };
  loop(v, 0);
  return uit;
}

export type DoelToets = { doel: string; waarde: number; doelwaarde: number; haalt: boolean };

/** Toetst een vingerafdruk aan de edit-doelen; kenmerken die er niet in staan vallen weg. */
export function toetsAanDoelen(vingerafdruk: unknown, doelen: EditDoelen): DoelToets[] {
  const getallen = getallenUit(vingerafdruk);
  const uit: DoelToets[] = [];
  for (const d of DOEL_KENMERKEN) {
    const naam = d.namen.map(norm).find((n) => getallen.has(n));
    if (!naam) continue;
    const waarde = getallen.get(naam) as number;
    const doelwaarde = doelen[d.doel];
    uit.push({ doel: d.doel, waarde, doelwaarde, haalt: d.beter === 'lager' ? waarde <= doelwaarde : waarde >= doelwaarde });
  }
  return uit;
}

/** Korte leesbare samenvatting van een vingerafdruk voor in een prompt. */
function vingerafdrukKort(v: unknown): string | null {
  if (!v) return null;
  const getallen = [...getallenUit(v).entries()].slice(0, 14).map(([k, w]) => `${k}=${Math.round(w * 100) / 100}`);
  return getallen.length ? getallen.join(', ') : JSON.stringify(v).slice(0, 300);
}

/* ------------------------------------------------------------ smaak-agent */

const lesSchema = z.object({
  lessen: z
    .array(
      z.object({
        categorie: z.enum(['editcraft', 'storycraft']),
        titel: z.string().describe('Korte, concrete titel (max ~10 woorden).'),
        inhoud: z
          .string()
          .describe('De les als toepasbare regel met getal of voorwaarde, plus in één zin het bewijs uit de renders.'),
        herkomst: z
          .enum(['eigen_smaak', 'eigen_cijfers', 'eigen_smaak_bevestigd_extern', 'eigen_cijfers_bevestigd_extern'])
          .describe('Waar de les op steunt. "bevestigd_extern" alleen als de externe normen of trends hetzelfde zeggen.'),
        renders: z.array(z.string()).describe('De sleutels (r1, r2, …) van de renders waarin het patroon terugkomt. Minstens 3.'),
      }),
    )
    .describe(`Hooguit ${MAX_LESSEN}. Een lege lijst is een geldig antwoord.`),
  samenvatting: z.string().describe('Twee à drie zinnen: wat zie je in de oordelen, en waarom wel of geen les.'),
});

const SMAAK_SYSTEM = `Je bent de smaak-agent van een clipping-tool. Je krijgt de oordelen van de makers over hun eigen gerenderde clips (goed / matig / weg, vaak met één zin waarom), de meetbare montagekenmerken (vingerafdruk) van die renders, de cijfers van wat er gepost is, en ter vergelijking de externe normen (wat top-clips van anderen meetbaar doen) en de trend-top-5.

Je destilleert hooguit ${MAX_LESSEN} concrete lessen voor de montage (editcraft) of het verhaal (storycraft).

Harde regels:
1. Een les alleen als het patroon bij minstens ${MIN_RENDERS_PER_LES} verschillende renders terugkomt. Noem die renders met hun sleutel (r1, r2, …). Eén opvallende clip is geen les.
2. De les is een toepasbare regel met een getal of een voorwaarde ("eerste knip vóór 1,5 s", "geen context-kaart als de hook al een vraag stelt"), geen algemeenheid ("maak het spannender").
3. Herkomst eerlijk: eigen_smaak als het alleen uit de oordelen komt; eigen_cijfers alleen als het op views van geposte renders steunt; "_bevestigd_extern" alleen als de externe normen of trends hetzelfde patroon laten zien. Spreken eigen smaak en externe data elkaar tegen, zeg dat dan in de inhoud.
4. De redenen van de makers wegen zwaarder dan jouw eigen interpretatie van de kenmerken. Verzin geen reden die niet in de data staat.
5. Wat al in de bestaande lessen staat, herhaal je niet.
6. Geen duidelijk patroon? Dan geen les. Een lege lijst is een goed antwoord.`;

export type SmaakResultaat = {
  overgeslagen: string | null;
  nieuweBeoordelingen: number;
  lessen: { categorie: KennisCategorie; titel: string; bron: string; bewaard: boolean }[];
  afgevallen: string[];
  samenvatting: string;
  agentRunId: string | null;
};

type RenderRegel = {
  sleutel: string;
  render_job_id: string;
  bestand: string;
  clip: number | null;
  hook_variant: number;
  titel: string | null;
  structure_type: string | null;
  hook_type: string | null;
  hook_tekst: string | null;
  oordeel: Oordeel | null;
  reden: string | null;
  keuring: string | null;
  vingerafdruk: string | null;
  doel_afwijkingen: string[];
  gepost: { platform: string | null; views_24h: number | null; views_7d: number | null; outlier_score: number | null } | null;
};

/**
 * Dagelijkse run. Stil overslaan (geen agent_run, geen Claude-call) als er
 * sinds de vorige run minder dan MIN_NIEUWE_BEOORDELINGEN oordelen bijkwamen.
 */
export async function runSmaakAgent(): Promise<SmaakResultaat> {
  const supabase = db();
  const leeg = (overgeslagen: string, nieuw: number): SmaakResultaat => ({
    overgeslagen,
    nieuweBeoordelingen: nieuw,
    lessen: [],
    afgevallen: [],
    samenvatting: '',
    agentRunId: null,
  });

  const { data: vorige } = await supabase
    .from('agent_runs')
    .select('created_at')
    .eq('agent', 'smaak')
    .order('created_at', { ascending: false })
    .limit(1);
  const sinds = (vorige?.[0]?.created_at as string | undefined) ?? '1970-01-01T00:00:00Z';

  const { count: nieuw, error: telFout } = await supabase
    .from('render_beoordelingen')
    .select('id', { count: 'exact', head: true })
    .gt('updated_at', sinds);
  if (telFout) throw new Error(`render_beoordelingen: ${telFout.message}`);
  if ((nieuw ?? 0) < MIN_NIEUWE_BEOORDELINGEN) {
    return leeg(`${nieuw ?? 0} nieuwe beoordeling(en) sinds de vorige run (< ${MIN_NIEUWE_BEOORDELINGEN})`, nieuw ?? 0);
  }

  // ------------------------------------------------------------ data
  const [{ data: oordelen }, { data: geposteClips }, doelen, normenTekst, trends, bestaandeKennis] = await Promise.all([
    supabase
      .from('render_beoordelingen')
      .select('render_job_id, bestand_naam, clip_index, hook_variant, oordeel, reden, updated_at')
      .order('updated_at', { ascending: false })
      .limit(150),
    supabase
      .from('clips')
      .select('render_job_id, render_bestand, platform, clip_performance(views_24h, views_7d, outlier_score)')
      .not('render_job_id', 'is', null)
      .eq('status', 'posted'),
    editDoelen(),
    editNormenVoorPrompt(),
    laadTrendTop5(),
    supabase
      .from('vault_kennis')
      .select('categorie, titel')
      .in('categorie', ['editcraft', 'storycraft'])
      .eq('actief', true)
      .order('created_at', { ascending: false })
      .limit(40),
  ]);

  const gepostPer = new Map<string, RenderRegel['gepost']>();
  for (const c of geposteClips ?? []) {
    const perf = one<{ views_24h: number | null; views_7d: number | null; outlier_score: number | null }>(c.clip_performance);
    gepostPer.set(`${c.render_job_id}|${c.render_bestand}`, {
      platform: (c.platform as string | null) ?? null,
      views_24h: perf?.views_24h ?? null,
      views_7d: perf?.views_7d ?? null,
      outlier_score: perf?.outlier_score === null || perf?.outlier_score === undefined ? null : Number(perf.outlier_score),
    });
  }

  const oordeelPer = new Map((oordelen ?? []).map((o) => [`${o.render_job_id}|${o.bestand_naam}`, o]));
  const jobIds = [
    ...new Set([
      ...(oordelen ?? []).map((o) => o.render_job_id as string),
      ...(geposteClips ?? []).map((c) => c.render_job_id as string),
    ]),
  ];
  const { data: jobs } = jobIds.length
    ? await supabase
        .from('render_jobs')
        .select('id, video_id, clip_index, titel, status, bestanden, created_at, gestart_at, klaar_at')
        .in('id', jobIds)
    : { data: [] };

  const regels: RenderRegel[] = [];
  for (const job of (jobs ?? []) as RenderJobRij[]) {
    const plan = await planVoorRender(job).catch(() => null);
    for (const b of job.bestanden ?? []) {
      const k = `${job.id}|${b.naam}`;
      const o = oordeelPer.get(k);
      const g = gepostPer.get(k) ?? null;
      if (!o && !g) continue;
      const nummer = clipNummerUitNaam(b.naam, job.clip_index);
      const variant = hookVariantVan(b);
      const info = planInfo(plan?.plan, nummer, variant);
      regels.push({
        sleutel: '',
        render_job_id: job.id,
        bestand: b.naam,
        clip: nummer,
        hook_variant: variant,
        titel: info.titel,
        structure_type: info.structure_type,
        hook_type: info.hook_type,
        hook_tekst: b.hook_tekst ?? null,
        oordeel: (o?.oordeel as Oordeel | undefined) ?? null,
        reden: (o?.reden as string | null | undefined) ?? null,
        keuring: b.keuring?.status ?? null,
        vingerafdruk: vingerafdrukKort(b.vingerafdruk),
        doel_afwijkingen: toetsAanDoelen(b.vingerafdruk, doelen)
          .filter((t) => !t.haalt)
          .map((t) => `${t.doel} ${Math.round(t.waarde * 100) / 100} (doel ${t.doelwaarde})`),
        gepost: g,
      });
    }
  }
  regels.forEach((r, i) => (r.sleutel = `r${i + 1}`));
  const perSleutel = new Map(regels.map((r) => [r.sleutel, r]));

  const telling = { goed: 0, matig: 0, weg: 0 } as Record<Oordeel, number>;
  for (const r of regels) if (r.oordeel) telling[r.oordeel]++;
  const metCijfers = regels.filter((r) => r.gepost && (r.gepost.views_24h !== null || r.gepost.views_7d !== null)).length;

  // ------------------------------------------------------------ Claude
  const antwoord = await structuredCall({
    system: SMAAK_SYSTEM,
    user: `=== EIGEN RENDERS (${regels.length}: ${telling.goed}× goed, ${telling.matig}× matig, ${telling.weg}× weg; ${metCijfers} gepost met cijfers) ===
${JSON.stringify(
  regels.map(({ render_job_id: _r, bestand: _b, ...rest }) => rest),
  null,
  1,
)}

=== HUIDIGE EDIT-DOELEN (bron: ${doelen.bron}, n=${doelen.n}) ===
${JSON.stringify(doelen)}

=== EXTERNE NORMEN (wat top-clips van anderen meetbaar doen) ===
${normenTekst || '— (nog niets gemeten; alleen standaarddoelen)'}

=== TREND-TOP-5 (extern) ===
${trends || '— (geen trendrapport)'}

=== BESTAANDE LESSEN (niet herhalen) ===
${(bestaandeKennis.data ?? []).map((k) => `- [${k.categorie}] ${k.titel}`).join('\n') || '—'}`,
    schema: lesSchema,
    toolName: 'lever_smaaklessen',
    toolDescription: 'Lever hooguit drie concrete lessen uit de eigen oordelen en cijfers, met de renders als bewijs.',
    maxTokens: 8000,
    effort: AGENT_EFFORT,
    operation: 'smaak_agent',
  });

  // ------------------------------------------------ regels in code afdwingen
  const afgevallen: string[] = [];
  const lessen: SmaakResultaat['lessen'] = [];
  for (const les of antwoord.lessen) {
    if (lessen.length >= MAX_LESSEN) {
      afgevallen.push(`${les.titel}: meer dan ${MAX_LESSEN} lessen`);
      continue;
    }
    const renders = [...new Set(les.renders)].map((s) => perSleutel.get(s)).filter((r): r is RenderRegel => Boolean(r));
    if (renders.length < MIN_RENDERS_PER_LES) {
      afgevallen.push(`${les.titel}: maar ${renders.length} bestaande render(s) als bewijs`);
      continue;
    }
    // Eigen cijfers claimen zonder geposte render met cijfers kan niet.
    let herkomst = les.herkomst;
    const renderMetCijfers = renders.filter((r) => r.gepost && (r.gepost.views_24h !== null || r.gepost.views_7d !== null));
    if (herkomst.startsWith('eigen_cijfers') && renderMetCijfers.length < MIN_RENDERS_PER_LES) {
      herkomst = herkomst.endsWith('bevestigd_extern') ? 'eigen_smaak_bevestigd_extern' : 'eigen_smaak';
    }
    const cijfers = herkomst.startsWith('eigen_cijfers');
    const extern = herkomst.endsWith('bevestigd_extern');
    const n = cijfers ? renderMetCijfers.length : renders.length;
    const oordeelTelling = (['goed', 'matig', 'weg'] as Oordeel[])
      .map((o) => [o, renders.filter((r) => r.oordeel === o).length] as const)
      .filter(([, c]) => c > 0)
      .map(([o, c]) => `${c}× ${o}`)
      .join(', ');
    const herkomstZin = cijfers
      ? `Herkomst: eigen cijfers (${n} geposte renders)${extern ? ', bevestigd door externe data' : ''}.`
      : `Herkomst: eigen smaak (${n} renders: ${oordeelTelling})${extern ? ', bevestigd door externe data' : ', nog niet extern bevestigd'}.`;
    const bron = `${cijfers ? 'eigen cijfers' : 'eigen beoordeling'} (n=${n})${extern ? ' + externe normen' : ''}`;

    const r = await bewaarKennis({
      categorie: les.categorie,
      titel: les.titel,
      inhoud: `${les.inhoud.trim()} ${herkomstZin}`,
      bron,
    });
    lessen.push({ categorie: les.categorie, titel: les.titel, bron, bewaard: r.bewaard });
    if (!r.bewaard) afgevallen.push(`${les.titel}: duplicaat (${r.reden})`);
  }

  const { data: run, error } = await supabase
    .from('agent_runs')
    .insert({
      agent: 'smaak',
      status: 'auto',
      decided_by: 'auto',
      input_summary: {
        nieuwe_beoordelingen: nieuw,
        renders: regels.length,
        oordelen: telling,
        gepost_met_cijfers: metCijfers,
        doelen_bron: doelen.bron,
        externe_normen: Boolean(normenTekst),
      },
      proposal: { ...antwoord, bewaard: lessen, afgevallen },
    })
    .select('id')
    .single();
  if (error) throw new Error(`agent_runs insert mislukt: ${error.message}`);

  return {
    overgeslagen: null,
    nieuweBeoordelingen: nieuw ?? 0,
    lessen,
    afgevallen,
    samenvatting: antwoord.samenvatting,
    agentRunId: run.id as string,
  };
}

/** Top-5 hooks en structuren uit het laatste trendrapport, als korte tekst. */
async function laadTrendTop5(): Promise<string> {
  try {
    const { data } = await db()
      .from('trend_rapporten')
      .select('rankings, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const rankings = data?.rankings as
      | { hooks?: { sleutel: string; aantal: number; accounts: number }[]; structuren?: { sleutel: string; aantal: number; accounts: number }[] }
      | undefined;
    if (!rankings) return '';
    const rij = (lijst?: { sleutel: string; aantal: number; accounts: number }[]) =>
      (lijst ?? [])
        .filter((r) => !r.sleutel.startsWith('nieuw:'))
        .slice(0, 5)
        .map((r) => `${r.sleutel} (${r.aantal} posts, ${r.accounts} accounts)`)
        .join(', ');
    return `Hooks: ${rij(rankings.hooks) || '—'}\nStructuren: ${rij(rankings.structuren) || '—'}`;
  } catch {
    return '';
  }
}
