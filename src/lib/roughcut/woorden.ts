import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../supabase';
import { resolveBinary } from '../ingest/binaries';
import { woordenVanFragment, type Woord } from './uitlijnen';

/**
 * Eén woordtranscriptie van de hele bronvideo als enige waarheid voor knippen.
 *
 * Waarom dit de definitieve oplossing is voor "hij knipt woorden af": alle
 * eerdere lagen werkten op verschillende, onnauwkeurige tijdbronnen — de
 * plantijden komen uit rollende ondertitelblokken (seconden ernaast), de
 * uitlijning transcribeerde losse venstertjes van een paar seconden (en juist
 * aan vensterranden zijn woordtijden rommel), en de stiltemeting weet wel wáár
 * een pauze zit maar niet welk woord ernaast staat. Elke controle probeerde
 * die bronnen met marges te verzoenen, en elke marge verschoof de fout.
 *
 * Met één transcriptie van het hele bestand vervalt dat allemaal: het model
 * krijgt volledige context (dan zijn de woordtijden wél stabiel), elk
 * scriptfragment wordt in de volledige tekst opgezocht, en de knip valt exact
 * tussen het laatste woord ervóór en het eerste woord van het fragment. Er
 * valt niets meer te raden.
 *
 * De transcriptie kost eenmalig een paar minuten per bronvideo en wordt in de
 * opslag gecachet; elke render daarna leest hem in een seconde terug.
 */

const BUCKET = 'montages';

export type BronWoord = Woord;

export async function haalBronWoorden(
  videoId: string,
  bronPad: string,
  opties: { model?: string; log?: (m: string) => void } = {},
): Promise<BronWoord[] | null> {
  const log = opties.log ?? (() => {});
  const model = opties.model ?? process.env.WHISPER_ALIGN_MODEL ?? 'base';
  const supabase = db();
  const cachePad = `woorden/${videoId}-${model}.json`;

  const bestaand = await supabase.storage.from(BUCKET).download(cachePad);
  if (bestaand.data) {
    try {
      const woorden = JSON.parse(await bestaand.data.text()) as BronWoord[];
      if (woorden.length > 50) {
        log(`brontranscriptie uit cache (${woorden.length} woorden)`);
        return woorden;
      }
    } catch {
      // kapotte cache: opnieuw maken
    }
  }

  log('bron woordelijk transcriberen (eenmalig per video)…');
  const werkmap = await mkdtemp(join(tmpdir(), 'clipper-woorden-'));
  try {
    const wav = join(werkmap, 'bron.wav');
    await new Promise<void>((klaar, fout) => {
      const kind = spawn(
        resolveBinary('ffmpeg'),
        ['-nostdin', '-y', '-i', bronPad, '-vn', '-ac', '1', '-ar', '16000', wav],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      kind.stderr.on('data', (d) => (stderr += d));
      kind.on('error', fout);
      kind.on('close', (code) => (code === 0 ? klaar() : fout(new Error(stderr.slice(-120)))));
    });

    const woorden = await woordenVanFragment(wav, model);
    if (woorden.length < 50) return null;

    await supabase.storage
      .from(BUCKET)
      .upload(cachePad, Buffer.from(JSON.stringify(woorden)), {
        contentType: 'application/json',
        upsert: true,
      });
    log(`brontranscriptie klaar en gecachet (${woorden.length} woorden)`);
    return woorden;
  } catch {
    return null;
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export type FragmentAnker = {
  /** Grenzen van het fragment, exact op de woorden. */
  start: number;
  end: number;
  /** Aandeel fragmentwoorden dat op zijn plek teruggevonden is (0..1). */
  score: number;
  /** Ruimte tot het vorige/volgende woord in de bron; bepaalt de knipmarge. */
  gapVoor: number;
  gapNa: number;
};

/**
 * Zoekt een scriptfragment op in de brontranscriptie en geeft exacte
 * woordgrenzen terug.
 *
 * De match is een gulzige volgorde-match met een kleine kijkafstand: elk
 * fragmentwoord mag maximaal drie transcriptiewoorden verderop gevonden worden
 * (transcriptie mist en verhaspelt er altijd een paar). Bij meerdere plekken
 * met dezelfde score wint de plek het dichtst bij de plantijd — een spreker
 * kan dezelfde zin vaker zeggen.
 */
export function vindFragment(
  woorden: BronWoord[],
  fragment: string,
  planStart: number,
): FragmentAnker | null {
  const doel = fragment.split(/\s+/).map(norm).filter((w) => w.length >= 2);
  if (doel.length < 3) return null;

  const bron = woorden
    .map((w, i) => ({ n: norm(w.w), i }))
    .filter((w) => w.n.length > 0);

  let beste: { van: number; tot: number; score: number; afstand: number } | null = null;

  for (let i = 0; i < bron.length; i++) {
    // Snelle poort: het eerste of tweede doelwoord moet hier ongeveer staan.
    if (bron[i].n !== doel[0] && bron[i].n !== doel[1]) continue;

    let cursor = i;
    let geraakt = 0;
    let laatste = i;
    for (const dw of doel) {
      let gevonden = -1;
      for (let k = cursor; k < Math.min(bron.length, cursor + 3); k++) {
        if (bron[k].n === dw) {
          gevonden = k;
          break;
        }
      }
      if (gevonden >= 0) {
        geraakt++;
        laatste = gevonden;
        cursor = gevonden + 1;
      } else {
        cursor++;
      }
    }

    const score = geraakt / doel.length;
    if (score < 0.55) continue;
    const afstand = Math.abs(woorden[bron[i].i].s - planStart);
    if (
      !beste ||
      score > beste.score + 0.08 ||
      (Math.abs(score - beste.score) <= 0.08 && afstand < beste.afstand)
    ) {
      beste = { van: bron[i].i, tot: bron[laatste].i, score, afstand };
    }
  }

  if (!beste) return null;

  const eerste = woorden[beste.van];
  const laatste = woorden[beste.tot];
  const vorig = woorden[beste.van - 1];
  const volgend = woorden[beste.tot + 1];

  return {
    start: eerste.s,
    end: laatste.e,
    score: beste.score,
    gapVoor: vorig ? Math.max(0, eerste.s - vorig.e) : 2,
    gapNa: volgend ? Math.max(0, volgend.s - laatste.e) : 2,
  };
}
