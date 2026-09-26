import 'dotenv/config';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { structuredCall } from '../src/lib/claude';
import { CLAUDE_LICHT_MODEL } from '../src/lib/env';
import { pakFrames } from '../src/lib/roughcut/frames';
import { db } from '../src/lib/supabase';
import {
  clipNummerUitNaam,
  hookVariantVan,
  laadEvalCases,
  laadRenderJob,
  zetEvalRendersKlaar,
  type EvalPaar,
  type RenderBestand,
  type RenderJobRij,
} from '../src/lib/tracking/leerlus';
import { downloadRender, laadVingerafdruk, toetsAanDoelen, type DoelToets } from '../src/lib/agents/smaak';
import { editDoelen, type EditDoelen } from '../src/lib/vault/normen';

/**
 * OPTIONELE smaak-eval. Niets hangt ervan af, CI draait hem niet vanzelf.
 *
 * De eval-set zijn renders die je in het renderpaneel hebt aangevinkt ("in
 * eval-set"), met jouw oordeel en reden. Na een wijziging aan de montage kun
 * je toetsen of dezelfde clips nu beter, gelijk of slechter uitkomen:
 *
 *   npm run eval:smaak                     # zet nieuwe renders klaar (huidige code), wacht niet
 *   npm run eval:smaak -- --droog          # laat zien wat er klaargezet zou worden
 *   npm run eval:smaak -- --uitslag        # vergelijk zodra die renders klaar zijn
 *   npm run eval:smaak -- --uitslag --forceer   # vergelijk wat al klaar is, ook als niet alles klaar is
 *   npm run eval:smaak -- --alleen-meten   # niets renderen: vergelijk met de laatste bestaande renders
 *
 * De vergelijking per paar: vingerafdruk-verschillen t.o.v. de edit-doelen
 * (als de vingerafdruk-module er is) plus één judge-call op het lichte model
 * die frames van beide ziet en de oorspronkelijke reden van je oordeel kent.
 * De uitslag komt in smaak_eval_runs en als tabel in de terminal.
 */

const HELP = `Gebruik: npm run eval:smaak -- [modus]

  (geen)            Zet per eval-case een nieuwe render klaar met de huidige code (titel "EVAL …").
  --droog           Toon wat er klaargezet zou worden, schrijf niets.
  --uitslag [id]    Vergelijk de renders van de laatste (of opgegeven) klaargezette eval-run met de originelen.
  --forceer         Bij --uitslag: vergelijk ook als nog niet alle renders klaar zijn.
  --alleen-meten    Render niets; vergelijk met de nieuwste bestaande render van dezelfde clip.
  --help            Deze tekst.

Optioneel: niets blokkeert hierop en CI draait dit niet vanzelf.`;

const judgeSchema = z.object({
  uitspraak: z.enum(['beter', 'gelijk', 'slechter']),
  reden_opgelost: z
    .boolean()
    .nullable()
    .describe('Is het bezwaar uit het oorspronkelijke oordeel in de nieuwe versie opgelost? Null als er geen bezwaar was.'),
  waarom: z.string().describe('Eén à twee zinnen, verwijzend naar wat je in de frames of kenmerken zag.'),
});

type PaarUitslag = {
  bestand: string;
  clip: number;
  hook_variant: number;
  oordeel: string;
  nieuw_job: string | null;
  nieuw_bestand: string | null;
  uitspraak: 'beter' | 'gelijk' | 'slechter' | 'onbekend';
  reden_opgelost: boolean | null;
  waarom: string;
  doelen: { doel: string; origineel: number | null; nieuw: number | null; doelwaarde: number; origineel_haalt: boolean | null; nieuw_haalt: boolean | null }[];
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  if (args.includes('--alleen-meten')) return alleenMeten();

  const uitslagIdx = args.indexOf('--uitslag');
  if (uitslagIdx >= 0) {
    const id = args[uitslagIdx + 1] && !args[uitslagIdx + 1].startsWith('--') ? args[uitslagIdx + 1] : null;
    return uitslag(id, args.includes('--forceer'));
  }

  const droog = args.includes('--droog');
  const r = await zetEvalRendersKlaar({ droog, door: 'eval:smaak (cli)' });
  if (r.paren.length === 0) {
    console.log('Geen eval-cases. Vink in het renderpaneel "in eval-set" aan bij renders die je als referentie wilt.');
    return;
  }
  console.log(
    droog
      ? `DROOG: zou ${r.nieuweJobs} render(s) klaarzetten voor ${r.paren.length} eval-case(s):`
      : `${r.nieuweJobs} nieuwe render(s) klaargezet voor ${r.paren.length} eval-case(s) (run ${r.runId}):`,
  );
  for (const p of r.paren) console.log(`  clip ${p.clip_index} · ${p.oordeel.padEnd(5)} · ${p.bestand_naam}${p.reden ? ` — "${p.reden}"` : ''}`);
  if (!droog) console.log('\nZodra de renders klaar zijn: npm run eval:smaak -- --uitslag');
}

/** --alleen-meten: niets renderen, de nieuwste bestaande render van dezelfde clip is "nieuw". */
async function alleenMeten() {
  const cases = await laadEvalCases();
  if (cases.length === 0) {
    console.log('Geen eval-cases.');
    return;
  }
  const supabase = db();
  for (const c of cases) {
    const origineel = await laadRenderJob(c.origineel_job);
    const { data } = await supabase
      .from('render_jobs')
      .select('id, clip_index, bestanden, created_at')
      .eq('video_id', c.video_id)
      .eq('status', 'klaar')
      .neq('id', c.origineel_job)
      .gt('created_at', origineel?.created_at ?? '1970-01-01')
      .order('created_at', { ascending: false })
      .limit(20);
    // Een job met "alle clips" telt ook, als hij deze clip bevat.
    const passend = (data ?? []).find((j) =>
      ((j.bestanden ?? []) as RenderBestand[]).some((b) => clipNummerUitNaam(b.naam, j.clip_index as number | null) === c.clip_index),
    );
    c.nieuw_job = (passend?.id as string | undefined) ?? null;
  }
  const { data: run, error } = await supabase
    .from('smaak_eval_runs')
    .insert({ config: { modus: 'alleen-meten', paren: cases }, uitslag: { status: 'klaargezet' } })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  await uitslag(run.id as string, true);
}

async function uitslag(runId: string | null, forceer: boolean) {
  const supabase = db();
  let query = supabase.from('smaak_eval_runs').select('id, config, uitslag, created_at');
  query = runId ? query.eq('id', runId) : query.eq('uitslag->>status', 'klaargezet').order('created_at', { ascending: false }).limit(1);
  const { data: runs, error } = await query;
  if (error) throw new Error(error.message);
  const run = runs?.[0];
  if (!run) {
    console.log('Geen klaargezette eval-run gevonden. Start er een met: npm run eval:smaak');
    return;
  }
  const paren = ((run.config as { paren?: EvalPaar[] }).paren ?? []) as EvalPaar[];

  // Wachten doen we niet zelf: klaar of niet, dat zeggen we.
  const nieuweJobs = new Map<string, RenderJobRij | null>();
  for (const id of new Set(paren.map((p) => p.nieuw_job).filter((x): x is string => Boolean(x)))) {
    nieuweJobs.set(id, await laadRenderJob(id));
  }
  const nietKlaar = [...nieuweJobs.values()].filter((j) => j && j.status !== 'klaar');
  if (nietKlaar.length > 0 && !forceer) {
    console.log(`Nog ${nietKlaar.length} van ${nieuweJobs.size} render(s) niet klaar:`);
    for (const j of nietKlaar) console.log(`  ${j!.id.slice(0, 8)} ${j!.status} — ${j!.titel ?? ''}`);
    console.log('Probeer later opnieuw, of vergelijk wat er is met --forceer.');
    return;
  }

  const doelen = await editDoelen();
  const vingerafdruk = await laadVingerafdruk();
  const uitslagen: PaarUitslag[] = [];

  for (const p of paren) {
    console.log(`→ clip ${p.clip_index} (${p.bestand_naam})`);
    const origJob = await laadRenderJob(p.origineel_job);
    const origBestand = origJob?.bestanden?.find((b) => b.naam === p.bestand_naam) ?? null;
    const nieuwJob = p.nieuw_job ? nieuweJobs.get(p.nieuw_job) ?? null : null;
    const nieuwBestand =
      nieuwJob?.status === 'klaar'
        ? (nieuwJob.bestanden ?? []).find(
            (b) => clipNummerUitNaam(b.naam, nieuwJob.clip_index) === p.clip_index && hookVariantVan(b) === p.hook_variant,
          ) ?? null
        : null;

    const basis = { bestand: p.bestand_naam, clip: p.clip_index, hook_variant: p.hook_variant, oordeel: p.oordeel, nieuw_job: p.nieuw_job };
    if (!origBestand || !nieuwBestand) {
      uitslagen.push({
        ...basis,
        nieuw_bestand: nieuwBestand?.naam ?? null,
        uitspraak: 'onbekend',
        reden_opgelost: null,
        waarom: !origBestand ? 'origineel niet meer gevonden' : 'geen (klare) nieuwe render van deze clip',
        doelen: [],
      });
      continue;
    }
    uitslagen.push({ ...basis, ...(await vergelijk(p, origBestand, nieuwBestand, doelen, vingerafdruk)) });
  }

  const geteld = uitslagen.filter((u) => u.uitspraak !== 'onbekend');
  const score = geteld.length
    ? Math.round((geteld.reduce((s, u) => s + (u.uitspraak === 'beter' ? 1 : u.uitspraak === 'slechter' ? -1 : 0), 0) / geteld.length) * 100) / 100
    : null;

  await supabase
    .from('smaak_eval_runs')
    .update({
      uitslag: { status: 'klaar', vergeleken_op: new Date().toISOString(), doelen_bron: doelen.bron, paren: uitslagen },
      score,
    })
    .eq('id', run.id);

  console.log('');
  console.log(['clip', 'var', 'oordeel', 'uitspraak', 'reden opgelost', 'doelen (orig→nieuw gehaald)', 'waarom'].join(' | '));
  for (const u of uitslagen) {
    const doelTekst = u.doelen.length
      ? `${u.doelen.filter((d) => d.origineel_haalt).length}→${u.doelen.filter((d) => d.nieuw_haalt).length}/${u.doelen.length}`
      : '—';
    console.log(
      [
        String(u.clip).padStart(4),
        String(u.hook_variant).padStart(3),
        u.oordeel.padEnd(7),
        u.uitspraak.padEnd(9),
        (u.reden_opgelost === null ? '—' : u.reden_opgelost ? 'ja' : 'nee').padEnd(14),
        doelTekst.padEnd(27),
        u.waarom.slice(0, 110),
      ].join(' | '),
    );
  }
  console.log(`\nScore ${score ?? '—'} (−1 = alles slechter, +1 = alles beter) over ${geteld.length} paar/paren · run ${run.id}`);
}

/** Eén paar: doelen-toets op beide vingerafdrukken + één judge-call met frames van beide. */
async function vergelijk(
  p: EvalPaar,
  orig: RenderBestand,
  nieuw: RenderBestand,
  doelen: EditDoelen,
  vingerafdruk: Awaited<ReturnType<typeof laadVingerafdruk>>,
): Promise<Omit<PaarUitslag, 'bestand' | 'clip' | 'hook_variant' | 'oordeel' | 'nieuw_job'>> {
  const mappen: string[] = [];
  try {
    const [o, n] = [await downloadRender(orig.pad), await downloadRender(nieuw.pad)];
    mappen.push(o.map, n.map);

    const vaOrig = orig.vingerafdruk ?? (vingerafdruk ? await vingerafdruk(o.bestand, { visueel: false }).catch(() => null) : null);
    const vaNieuw = nieuw.vingerafdruk ?? (vingerafdruk ? await vingerafdruk(n.bestand, { visueel: false }).catch(() => null) : null);
    const tOrig = vaOrig ? toetsAanDoelen(vaOrig, doelen) : [];
    const tNieuw = vaNieuw ? toetsAanDoelen(vaNieuw, doelen) : [];
    const doelNamen = [...new Set([...tOrig, ...tNieuw].map((t) => t.doel))];
    const vind = (lijst: DoelToets[], d: string) => lijst.find((t) => t.doel === d) ?? null;
    const doelVergelijking = doelNamen.map((d) => ({
      doel: d,
      origineel: vind(tOrig, d)?.waarde ?? null,
      nieuw: vind(tNieuw, d)?.waarde ?? null,
      doelwaarde: (vind(tOrig, d) ?? vind(tNieuw, d))!.doelwaarde,
      origineel_haalt: vind(tOrig, d)?.haalt ?? null,
      nieuw_haalt: vind(tNieuw, d)?.haalt ?? null,
    }));

    const [fo, fn] = [
      await pakFrames(o.bestand, { bronBestand: o.bestand, maxFrames: 6 }),
      await pakFrames(n.bestand, { bronBestand: n.bestand, maxFrames: 6 }),
    ];
    mappen.push(fo.map, fn.map);
    if (fo.frames.length === 0 || fn.frames.length === 0) {
      return { nieuw_bestand: nieuw.naam, uitspraak: 'onbekend', reden_opgelost: null, waarom: `geen frames: ${fo.fout ?? fn.fout ?? '?'}`, doelen: doelVergelijking };
    }

    const oordeel = await structuredCall({
      system: `Je vergelijkt twee versies van dezelfde short-form clip: het ORIGINEEL (dat een maker al beoordeelde) en een NIEUWE render van dezelfde clip met nieuwere montagecode. Zeg of de nieuwe versie beter, gelijk of slechter is — voor een kijker die door een feed scrolt. Het oorspronkelijke oordeel en de reden van de maker wegen het zwaarst: is dát bezwaar opgelost? Kijk naar de frames voor je oordeelt; verzin niets wat je niet ziet. Twijfel = gelijk.`,
      user: `Oorspronkelijk oordeel van de maker: ${p.oordeel}${p.reden ? ` — "${p.reden}"` : ' (geen reden gegeven)'}

Frames ORIGINEEL staan in: ${fo.map}
Frames NIEUW staan in: ${fn.map}

Edit-doelen (bron ${doelen.bron}): ${JSON.stringify(doelen)}
Toets aan de doelen (origineel → nieuw): ${doelVergelijking.length ? JSON.stringify(doelVergelijking) : 'geen vingerafdruk beschikbaar'}`,
      schema: judgeSchema,
      toolName: 'lever_vergelijking',
      toolDescription: 'Lever je uitspraak over de nieuwe versie ten opzichte van het origineel.',
      maxTokens: 2000,
      effort: 'low',
      operation: 'smaak_eval_judge',
      model: CLAUDE_LICHT_MODEL,
      beeldPaden: [...fo.frames.map((f) => f.pad), ...fn.frames.map((f) => f.pad)],
    });
    return { nieuw_bestand: nieuw.naam, ...oordeel, doelen: doelVergelijking };
  } catch (e) {
    return { nieuw_bestand: nieuw.naam, uitspraak: 'onbekend', reden_opgelost: null, waarom: `fout: ${(e as Error).message.slice(0, 160)}`, doelen: [] };
  } finally {
    for (const m of mappen) await rm(m, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('eval:smaak FOUT:', e instanceof Error ? e.message : e);
  process.exit(1);
});
