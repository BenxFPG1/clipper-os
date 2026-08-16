import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/lib/supabase';
import { r2Download } from '../src/lib/r2';
import { keurMontage, type Keuringsrapport } from '../src/lib/roughcut/keuring';
import { bronWoordenUitCache } from '../src/lib/roughcut/woorden';
import { pythonMetOpenCV } from '../src/lib/python';

/**
 * De regressiesuite voor montages.
 *
 * Dit is het vangnet dat er niet was, en waarvan het ontbreken de eigenlijke
 * oorzaak was dat elke fix iets anders sloopte: er bestond geen enkele
 * controle die, ná een wijziging, de eerder opgeloste problemen opnieuw
 * toetste. Elke verbetering was een gok.
 *
 * Hoe hij werkt: een vaste set clips wordt gerenderd en gekeurd op dezelfde
 * regels die de render zelf gebruikt. De uitslag gaat naast de vorige uitslag
 * (`eval/montage-baseline.json`). Een regel die eerst goed was en nu fout is,
 * is een regressie — en dan faalt dit script. Nieuwe regels die goed worden,
 * worden juist in de basislijn opgenomen.
 *
 * Draaien:
 *   npm run eval:montage            keuren tegen de basislijn
 *   npm run eval:montage -- --leg-vast   uitslag als nieuwe basislijn vastleggen
 *
 * De set staat in eval/montage-cases.json en bevat bewust verschillende
 * soorten bronmateriaal: een Vlaams tweegesprek waar spraakherkenning op
 * struikelt, een schone studio-opname, een bewegende spreker. Drempels die
 * alleen op één clip zijn afgesteld vallen daarmee meteen door de mand.
 */

type Geval = {
  naam: string;
  video_id: string;
  clip_index: number;
  /** Alleen de keuring draaien op een bestaand bestand, niet renderen. */
  bestand?: string;
};

type Uitslag = { naam: string; goed: boolean; regels: Record<string, boolean>; details: Record<string, string> };

const EVAL_MAP = join(process.cwd(), 'eval');
const CASES = join(EVAL_MAP, 'montage-cases.json');
const BASIS = join(EVAL_MAP, 'montage-baseline.json');

async function main() {
  const legVast = process.argv.includes('--leg-vast');

  if (!existsSync(CASES)) {
    console.error(`Geen evaluatieset gevonden op ${CASES}.`);
    process.exit(2);
  }
  const gevallen = JSON.parse(await readFile(CASES, 'utf8')) as Geval[];
  const supabase = db();

  const uitslagen: Uitslag[] = [];
  for (const geval of gevallen) {
    console.log(`\n── ${geval.naam}`);

    // Het gerenderde bestand ophalen: uit de opgegeven plek, of het laatste
    // resultaat van deze clip uit de opslag.
    let pad = geval.bestand;
    if (!pad) {
      // Niet blind de nieuwste opdracht pakken: die kan een losse render van
      // een ándere clip van dezelfde video zijn. Zoek in de recente opdrachten
      // naar een bestand dat bij déze clip_index hoort (bestandsnamen beginnen
      // met het clipnummer: "05-...").
      const { data: jobs } = await supabase
        .from('render_jobs')
        .select('bestanden')
        .eq('video_id', geval.video_id)
        .eq('status', 'klaar')
        .order('klaar_at', { ascending: false })
        .limit(10);
      const voorvoegsel = `${String(geval.clip_index).padStart(2, '0')}-`;
      const bestand = (jobs ?? [])
        .flatMap((j) => (j.bestanden as { naam: string; pad: string }[] | null) ?? [])
        .find((b) => b.naam.startsWith(voorvoegsel));
      if (!bestand) {
        console.log('   geen gerenderde clip gevonden; overgeslagen');
        continue;
      }
      const dl = await r2Download(bestand.pad);
      if (!dl.data) {
        console.log('   download mislukt; overgeslagen');
        continue;
      }
      pad = join(EVAL_MAP, `${geval.naam.replace(/[^\w-]+/g, '-')}.mp4`);
      await writeFile(pad, Buffer.from(await dl.data.arrayBuffer()));
    }

    // De segmenten en woorden horen bij de opdracht; zonder die twee kunnen we
    // alleen de beeld- en geluidsregels toetsen.
    const { data: plan } = await supabase
      .from('clip_plans')
      .select('montageplan')
      .eq('video_id', geval.video_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const opgeslagen = (plan?.montageplan as { clips?: Record<string, unknown> } | null) ?? null;
    const clipPlan = opgeslagen?.clips?.[String(geval.clip_index)] as
      | { segmenten: never[] }
      | undefined;
    const woorden = await bronWoordenUitCache(geval.video_id);

    const rapport: Keuringsrapport = await keurMontage(
      pad,
      clipPlan?.segmenten ?? [],
      woorden,
      { python: pythonMetOpenCV() },
    );

    for (const r of rapport.regels) console.log(`   ${r.goed ? '✓' : '✗'} ${r.naam}: ${r.detail}`);
    uitslagen.push({
      naam: geval.naam,
      goed: rapport.goed,
      regels: Object.fromEntries(rapport.regels.map((r) => [r.naam, r.goed])),
      details: Object.fromEntries(rapport.regels.map((r) => [r.naam, r.detail])),
    });
  }

  if (legVast) {
    await writeFile(BASIS, JSON.stringify(uitslagen, null, 2));
    console.log(`\nBasislijn vastgelegd (${uitslagen.length} clips).`);
    return;
  }

  if (!existsSync(BASIS)) {
    await writeFile(BASIS, JSON.stringify(uitslagen, null, 2));
    console.log('\nNog geen basislijn; deze uitslag is nu de basislijn.');
    return;
  }

  // Vergelijken: alleen achteruitgang is een fout. Vooruitgang wordt gemeld en
  // hoort daarna met --leg-vast vastgelegd te worden.
  const basis = JSON.parse(await readFile(BASIS, 'utf8')) as Uitslag[];
  const regressies: string[] = [];
  const verbeteringen: string[] = [];

  for (const nu of uitslagen) {
    const eerder = basis.find((b) => b.naam === nu.naam);
    if (!eerder) continue;
    for (const [regel, goed] of Object.entries(nu.regels)) {
      const was = eerder.regels[regel];
      if (was === true && goed === false) regressies.push(`${nu.naam} → ${regel}: ${nu.details[regel]}`);
      if (was === false && goed === true) verbeteringen.push(`${nu.naam} → ${regel}`);
    }
  }

  console.log('\n══ uitslag');
  for (const v of verbeteringen) console.log(`   + verbeterd: ${v}`);
  for (const r of regressies) console.log(`   ! REGRESSIE: ${r}`);

  if (regressies.length > 0) {
    console.log(`\n${regressies.length} regressie(s). Deze wijziging maakt iets kapot dat werkte.`);
    process.exit(1);
  }
  console.log(`\nGeen regressies${verbeteringen.length ? `, ${verbeteringen.length} verbetering(en)` : ''}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
