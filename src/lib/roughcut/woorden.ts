import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { r2Download, r2Upload } from '../r2';
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

export type BronWoord = Woord;

/**
 * Alleen de cache lezen: voor gereedschap dat de bronvideo niet bij de hand
 * heeft, zoals de evaluatieset.
 */
export async function bronWoordenUitCache(
  videoId: string,
  model = process.env.WHISPER_BRON_MODEL ?? 'small',
): Promise<BronWoord[] | null> {
  const dl = await r2Download(`woorden/${videoId}-${model}.json`);
  if (!dl.data) return null;
  try {
    const woorden = JSON.parse(await dl.data.text()) as BronWoord[];
    return woorden.length > 50 ? woorden : null;
  } catch {
    return null;
  }
}

export async function haalBronWoorden(
  videoId: string,
  bronPad: string,
  opties: { model?: string; log?: (m: string) => void } = {},
): Promise<BronWoord[] | null> {
  const log = opties.log ?? (() => {});
  // 'small' in plaats van 'base': base verstaat dit soort Vlaams zo matig dat
  // fragmenten onvindbaar worden en de verificatie vals alarm slaat — en op
  // vals alarm gaat elk herstel de verkeerde kant op. De transcriptie is
  // eenmalig per video en gecachet, dus het duurdere model kost per saldo
  // vrijwel niets.
  const model = opties.model ?? process.env.WHISPER_BRON_MODEL ?? 'small';
  const cachePad = `woorden/${videoId}-${model}.json`;

  const bestaand = await r2Download(cachePad);
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

    // Het uploadresultaat wordt gecheckt: een stille misser betekent dat elke
    // volgende render opnieuw tien minuten transcribeert.
    const upload = await r2Upload(cachePad, Buffer.from(JSON.stringify(woorden)), 'application/json');
    if (upload.error) {
      log(`LET OP: transcriptiecache niet opgeslagen (${upload.error.message}); volgende render transcribeert opnieuw`);
    } else {
      log(`brontranscriptie klaar en gecachet (${woorden.length} woorden)`);
    }
    return woorden;
  } catch {
    return null;
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export type FragmentAnker = {
  /**
   * Grenzen van het fragment, exact op de woorden. Null betekent: die kant is
   * niet met genoeg zekerheid gematcht — gebruik daar de planwaarde met de
   * gewone controles.
   */
  start: number | null;
  end: number | null;
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

  // Verhaspelingsbestendig vergelijken. Namen wijken af ("Philippe" voor
  // "Philip"), en getallen worden in losse tokens gehoord ("4.000" wordt
  // "4" + "000") — allebei funest voor exacte gelijkheid.
  const isCijfer = (x: string) => /^\d+$/.test(x);
  const lijkt = (a: string, b: string) => {
    if (a === b) return true;
    if (isCijfer(a) && isCijfer(b)) return a.includes(b) || b.includes(a);
    return a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
  };

  let beste: {
    van: number;
    tot: number;
    score: number;
    afstand: number;
    kopRaak: number;
    staartRaak: number;
  } | null = null;

  for (let i = 0; i < bron.length; i++) {
    if (!lijkt(bron[i].n, doel[0]) && !lijkt(bron[i].n, doel[1]) && !lijkt(bron[i].n, doel[2] ?? '')) {
      continue;
    }

    // Echte sequentie-uitlijning (LCS) over een venster. De eerdere
    // cursor-varianten konden óf invoegingen óf weglatingen aan, nooit beide:
    // de spreker zegt extra woorden die het script niet citeert ("denk ik
    // zelfs") én het script bevat woorden die de transcriptie mist — en één
    // hapering liet dan de hele rest van de zin cascaderen naar nul.
    const venster = bron.slice(i, i + doel.length * 2 + 12);
    const n = venster.length;
    const m = doel.length;
    // dp[k][d] = langste gedeelde deelreeks van venster[k..] en doel[d..]
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let k = n - 1; k >= 0; k--) {
      for (let d = m - 1; d >= 0; d--) {
        dp[k][d] = lijkt(venster[k].n, doel[d])
          ? 1 + dp[k + 1][d + 1]
          : Math.max(dp[k + 1][d], dp[k][d + 1]);
      }
    }

    const geraakt = dp[0][0];
    const score = geraakt / m;
    if (score < 0.55) continue;

    // Terugloop: welke woorden zijn gematcht, en dus waar liggen de randen?
    let k = 0;
    let d = 0;
    let eersteMatch = -1;
    let laatsteMatch = -1;
    let eersteDoel = -1;
    let laatsteDoel = -1;
    while (k < n && d < m) {
      if (lijkt(venster[k].n, doel[d]) && dp[k][d] === 1 + dp[k + 1][d + 1]) {
        if (eersteMatch < 0) {
          eersteMatch = k;
          eersteDoel = d;
        }
        laatsteMatch = k;
        laatsteDoel = d;
        k++;
        d++;
      } else if (dp[k + 1][d] >= dp[k][d + 1]) {
        k++;
      } else {
        d++;
      }
    }
    if (eersteMatch < 0) continue;

    // Getallen worden als losse tokens gehoord ("4" + ".000"); het anker moet
    // dan tot het láátste stuk van het getal doorlopen, anders eindigt de clip
    // middenin "4.000".
    while (
      laatsteMatch + 1 < n &&
      isCijfer(venster[laatsteMatch + 1].n) &&
      isCijfer(doel[laatsteDoel]) &&
      doel[laatsteDoel].includes(venster[laatsteMatch + 1].n)
    ) {
      laatsteMatch++;
    }

    const afstand = Math.abs(woorden[venster[eersteMatch].i].s - planStart);
    if (
      !beste ||
      score > beste.score + 0.08 ||
      (Math.abs(score - beste.score) <= 0.08 && afstand < beste.afstand)
    ) {
      beste = {
        van: venster[eersteMatch].i,
        tot: venster[laatsteMatch].i,
        score,
        afstand,
        // Zekerheid per kant: het eerste gematchte fragmentwoord moet bij de
        // kop horen, het laatste bij de staart. Tellen hoevéél kopwoorden
        // raakten bleek te streng bij korte functiewoorden.
        kopRaak: eersteDoel >= 0 && eersteDoel <= 2 ? 2 : 0,
        staartRaak: laatsteDoel >= m - 4 ? 2 : 0,
      };
    }
  }

  if (!beste) return null;

  // Kant-vertrouwen: een anker geldt per kant alleen als die kant van het
  // fragment ook echt gematcht is. Een half-geslaagd anker dat zijn einde op
  // het laatst gematchte woord legt, hakt anders scriptinhoud af.
  const startZeker = beste.kopRaak >= 2;
  const eindZeker = beste.staartRaak >= 2;
  if (!startZeker && !eindZeker) return null;

  const eerste = woorden[beste.van];
  const laatste = woorden[beste.tot];
  const vorig = woorden[beste.van - 1];
  const volgend = woorden[beste.tot + 1];

  return {
    start: startZeker ? eerste.s : null,
    end: eindZeker ? laatste.e : null,
    score: beste.score,
    gapVoor: vorig ? Math.max(0, eerste.s - vorig.e) : 2,
    gapNa: volgend ? Math.max(0, volgend.s - laatste.e) : 2,
  };
}
