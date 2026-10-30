/**
 * De testset: vijf fragmenten van verschillende soorten video. Elke fix aan
 * planner of clipregels moet op alle vijf werken, niet alleen op de clip waar
 * de fout zat (PLATINA werd 13 rondes beter, MUKBANG viel daarna meteen door
 * de mand). Alleen plannen, niets wegschrijven: het script is waar de grootste
 * fouten zitten, en dat is te keuren zonder te renderen.
 *
 * Draaien (in CI via .github/workflows/testset.yml):
 *   npx tsx scripts/testset.ts [naam,naam]
 */
import 'dotenv/config';
import { runPlannerForVideo } from '../src/lib/planner/run';
import { clipDuur, lengteBereik, pasClipRegelsToe, sprongen, zelfstandigeOpening, zinnen, type Formaat } from '../src/lib/planner/clipregels';

const SET = [
  { naam: 'uitleg-platina', video: '82df1c6f-fc95-4c5e-a78d-2a713a5fbfee', van: 268, tot: 318 },
  { naam: 'comedy-mukbang', video: 'ad3cfac5-b675-4d47-9f42-a0f9ec02def2', van: 60, tot: 260 },
  { naam: 'interview-koen', video: 'a48414d1-cb86-4d88-9769-ebd22f80a096', van: 600, tot: 900 },
  { naam: 'verhaal-dierenambulance', video: 'a894505d-13cf-452a-9f77-b72beff699b1', van: 600, tot: 900 },
  { naam: 'groep-rad', video: '915bf97b-a654-48ef-a5e0-a0b9000364d7', van: 300, tot: 600 },
];
const TEGELIJK = 3;

type Uitslag = { naam: string; goed: boolean; regels: string[] };

async function toets(t: (typeof SET)[number]): Promise<Uitslag> {
  const t0 = Date.now();
  try {
    const { plan, formaat, transcript, titel } = await runPlannerForVideo(t.video, { bereik: { van: t.van, tot: t.tot }, opslaan: false });
    const clip = plan.clips[0];
    if (!clip) return { naam: t.naam, goed: false, regels: ['geen clip in het plan'] };
    const f = (formaat ?? 'uitleg') as Formaat;
    const { oordeel } = pasClipRegelsToe(clip, f, { transcript, titel });
    const zs = clip.shots.flatMap((s) => zinnen(s.transcript_fragment ?? ''));
    const eerste = zs[0] ?? '';
    const laatste = zs[zs.length - 1] ?? '';
    const { min, max } = lengteBereik(f);
    const duur = clipDuur(clip);
    const fouten = [...oordeel.fouten];
    // Dezelfde maatstaf als de regels; hier nog eens hard op het eindresultaat.
    if (f !== 'comedy' && !zelfstandigeOpening(eerste)) fouten.push(`opening niet zelfstandig: "${eerste.slice(0, 60)}"`);
    if (!/[.!?…]["'”)]*$/.test(laatste.trim())) fouten.push(`eindigt niet op een hele zin: "${laatste.slice(-60)}"`);
    if (duur < min - 0.5 || duur > max + 0.5) fouten.push(`${duur.toFixed(0)} s, buiten ${min}–${max} s`);
    return {
      naam: t.naam,
      goed: fouten.length === 0,
      regels: [
        `formaat ${f}, ${duur.toFixed(0)} s, ${clip.shots.length} shots, ${sprongen(clip).length} sprong(en) ${JSON.stringify(sprongen(clip).map((s) => s.seconden))}, score ${clip.score ?? '—'}, ${((Date.now() - t0) / 1000).toFixed(0)} s plannen`,
        `titel:   ${clip.titel_intern}`,
        `overlay: ${clip.hook?.tekst_overlay ?? '—'}`,
        `begint:  ${eerste.slice(0, 110)}`,
        `eindigt: ${laatste.slice(-110)}`,
        ...fouten.map((x) => `FOUT: ${x}`),
        ...oordeel.signalen.slice(0, 3).map((x) => `signaal: ${x.slice(0, 140)}`),
      ],
    };
  } catch (e) {
    return { naam: t.naam, goed: false, regels: [`FOUT: planner faalde: ${(e as Error).message.slice(0, 200)}`] };
  }
}

/** Alle scripts die de planner uit een hele video haalt, om te lezen vóór er iets gerenderd wordt. */
async function kandidaten(videoId: string) {
  const { plan, formaat } = await runPlannerForVideo(videoId, { opslaan: false });
  console.log(`\n=== KANDIDATEN (${formaat}) ===`);
  for (const [i, clip] of plan.clips.entries()) {
    console.log(`\n${i + 1}. ${clip.titel_intern} — ${clipDuur(clip).toFixed(0)} s, score ${clip.score ?? '—'}, ${Math.min(...clip.shots.map((s) => s.start)).toFixed(0)}-${Math.max(...clip.shots.map((s) => s.end)).toFixed(0)} s`);
    console.log(`   overlay: ${clip.hook?.tekst_overlay ?? '—'}`);
    for (const s of clip.shots) console.log(`   [${s.functie}] ${s.transcript_fragment ?? ''}`);
  }
}

async function main() {
  if (process.argv[2]?.startsWith('kandidaten:')) return kandidaten(process.argv[2].slice('kandidaten:'.length));
  const keuze = process.argv[2]?.split(',').filter(Boolean);
  const rij = SET.filter((t) => !keuze?.length || keuze.includes(t.naam));
  const uit: Uitslag[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: TEGELIJK }, async () => {
      while (i < rij.length) uit.push(await toets(rij[i++]));
    }),
  );
  uit.sort((a, b) => rij.findIndex((t) => t.naam === a.naam) - rij.findIndex((t) => t.naam === b.naam));
  console.log('\n=== TESTSET ===');
  for (const u of uit) {
    console.log(`\n${u.goed ? 'GOED' : 'FOUT'}  ${u.naam}`);
    for (const r of u.regels) console.log(`  ${r}`);
  }
  const fout = uit.filter((u) => !u.goed).length;
  console.log(`\n${uit.length - fout}/${uit.length} goed`);
  if (fout) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
