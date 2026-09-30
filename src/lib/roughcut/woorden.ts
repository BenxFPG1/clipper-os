import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { r2Download, r2Upload } from '../r2';
import { resolveBinary } from '../ingest/binaries';
import { type Woord } from './uitlijnen';
import { instelling } from './instellingen';
import { sectiePlan } from './renderbron';

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

/**
 * Een woord met zijn tijden in de bron. `grof`: niet door spraakherkenning
 * gemeten maar evenredig verdeeld binnen een transcriptsegment (terugval als
 * transcriberen mislukt). Goed genoeg voor ondertitels en ruwe woordgrenzen,
 * niet voor een knip op de frame.
 */
export type BronWoord = Woord & { grof?: boolean };

/** Een segment uit videos.transcript (YouTube-captions, handmatig of Whisper). */
export type TranscriptSegmentTijd = { start_seconds: number; end_seconds: number; text: string };

export type BronTranscribeer = (wav: string, model: string, timeoutMs: number) => Promise<BronWoord[]>;
export type BronWoordCache = { lees: (sleutel: string) => Promise<BronWoord[] | null>; schrijf: (sleutel: string, w: BronWoord[]) => Promise<void> };

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

/**
 * Grove woordtijden uit een transcript met segmenttijden: de woorden van een
 * segment evenredig (naar lengte) over het segment verdeeld, elk met een
 * klein gat erna zodat er woordgrenzen zijn om op te knippen.
 */
export function groveWoorden(segmenten: TranscriptSegmentTijd[], van = -Infinity, tot = Infinity): BronWoord[] {
  const uit: BronWoord[] = [];
  // YouTube-captions overlappen: een blok staat nog in beeld terwijl het
  // volgende al begint. Evenredig verdeeld gaf dat woorden van twee blokken
  // door elkaar op dezelfde tijden — en twee ondertitelregels over elkaar.
  // Elk blok eindigt dus waar het volgende begint.
  const gesorteerd = [...segmenten]
    .filter((x) => Number.isFinite(Number(x.start_seconds)) && Number.isFinite(Number(x.end_seconds)))
    .sort((a, b) => Number(a.start_seconds) - Number(b.start_seconds));
  for (const [i, seg] of gesorteerd.entries()) {
    const s0 = Number(seg.start_seconds);
    const volgendeStart = gesorteerd.slice(i + 1).find((x) => Number(x.start_seconds) > s0)?.start_seconds;
    const s1 = Math.min(Number(seg.end_seconds), volgendeStart !== undefined ? Number(volgendeStart) : Infinity);
    if (!(s1 > s0) || s1 <= van || s0 >= tot) continue;
    // [muziek] en dergelijke weg, en het streepje waarmee captions een
    // sprekerwissel aangeven ("- Dat is", "-Dat is").
    const woorden = String(seg.text ?? '')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/(^|\s)[-–—]+(?=\s|\p{L}|\d)/gu, '$1')
      .split(/\s+/)
      .filter(Boolean);
    if (woorden.length === 0) continue;
    const gewicht = woorden.map((w) => w.length + 1);
    const totaal = gewicht.reduce((t, g) => t + g, 0);
    let t = s0;
    woorden.forEach((w, i) => {
      const slot = ((s1 - s0) * gewicht[i]) / totaal;
      const r = (x: number) => Math.round(x * 1000) / 1000;
      uit.push({ w, s: r(t), e: r(t + slot * 0.85), grof: true });
      t += slot;
    });
  }
  return uit.filter((w) => (w.s + w.e) / 2 >= van && (w.s + w.e) / 2 <= tot).sort((a, b) => a.s - b.s);
}

function knipWav(bron: string, van: number | null, tot: number | null, wav: string): Promise<void> {
  return new Promise((klaar, fout) => {
    const tijd = van !== null && tot !== null ? ['-ss', van.toFixed(3), '-t', (tot - van).toFixed(3)] : [];
    const kind = spawn(resolveBinary('ffmpeg'), ['-nostdin', '-y', ...tijd, '-i', bron, '-vn', '-ac', '1', '-ar', '16000', wav], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    kind.stderr.on('data', (d) => (stderr += d));
    kind.on('error', fout);
    kind.on('close', (code) => (code === 0 ? klaar() : fout(new Error(`ffmpeg (audio knippen) exit ${code}: ${stderr.trim().slice(-120)}`))));
  });
}

/**
 * De woordtijden uit de bron: de enige waarheid voor knipgrenzen.
 *
 * Voorheen transcribeerde dit de héle video in één keer. Bij een podcast van
 * twintig minuten faalde dat in CI stil — geen woorden, dus geen
 * ondertitels, geen retentie en geen woordgrenskeuring. Nu:
 *
 *  1. Staat er nog een hele-video-cache (oudere renders), dan die.
 *  2. Anders alleen de bereiken die de clips van deze opdracht gebruiken
 *     (plus BRON_BEREIK_MARGE aan weerszijden, voor ankers die verschuiven),
 *     elk apart gecachet. Een uur podcast kost zo evenveel als zes minuten.
 *  3. Lukt een bereik niet, dan staat de oorzaak in de log en komen de
 *     woorden daar uit het transcript van de video (YouTube-captions),
 *     evenredig verdeeld en gemarkeerd als grof.
 */
export async function haalBronWoorden(
  videoId: string,
  bronPad: string,
  opties: {
    model?: string;
    log?: (m: string) => void;
    /** De brontijdvakken die deze opdracht gebruikt (shots van de clips). Zonder: de hele video. */
    bereiken?: { start: number; end: number }[];
    /** videos.transcript: terugval voor grove woordtijden. */
    transcript?: TranscriptSegmentTijd[] | null;
    transcribeer?: BronTranscribeer;
    cache?: BronWoordCache;
  } = {},
): Promise<BronWoord[] | null> {
  const log = opties.log ?? (() => {});
  // 'small' in plaats van 'base': base verstaat dit soort Vlaams zo matig dat
  // fragmenten onvindbaar worden en de verificatie vals alarm slaat.
  const model = opties.model ?? process.env.WHISPER_BRON_MODEL ?? 'small';
  const cache: BronWoordCache = opties.cache ?? {
    lees: async (sleutel) => {
      const dl = await r2Download(sleutel);
      if (!dl.data) return null;
      try {
        return JSON.parse(await dl.data.text()) as BronWoord[];
      } catch {
        return null;
      }
    },
    schrijf: async (sleutel, w) => {
      const upload = await r2Upload(sleutel, Buffer.from(JSON.stringify(w)), 'application/json');
      if (upload.error) throw upload.error;
    },
  };
  const transcribeer: BronTranscribeer =
    opties.transcribeer ?? (async (wav, m, timeoutMs) => (await import('./ondertitelwoorden')).transcribeerViaAlign(wav, m, timeoutMs));

  const heel = await cache.lees(`woorden/${videoId}-${model}.json`).catch(() => null);
  if (heel && heel.length > 50) {
    log(`brontranscriptie uit cache (${heel.length} woorden, hele video)`);
    return heel;
  }

  const bereiken = opties.bereiken?.filter((b) => b.end > b.start) ?? [];
  const secties: { van: number | null; tot: number | null }[] = bereiken.length
    ? sectiePlan(bereiken, { marge: instelling('BRON_BEREIK_MARGE'), samenvoegGat: instelling('BRON_BEREIK_MARGE') })
    : [{ van: null, tot: null }];
  const regels: string[] = [];
  const alle: BronWoord[] = [];
  let grof = 0;
  const werkmap = await mkdtemp(join(tmpdir(), 'clipper-woorden-'));
  try {
    for (const sec of secties) {
      const naam = sec.van === null ? 'hele video' : `${sec.van.toFixed(0)}-${sec.tot!.toFixed(0)} s`;
      const sleutel = sec.van === null ? `woorden/${videoId}-${model}.json` : `woorden/${videoId}-${model}-${sec.van.toFixed(1)}-${sec.tot!.toFixed(1)}.json`;
      const bestaand = sec.van === null ? null : await cache.lees(sleutel).catch(() => null);
      if (bestaand && bestaand.length > 0) {
        alle.push(...bestaand);
        regels.push(`${naam} uit cache (${bestaand.length})`);
        continue;
      }
      const duur = sec.van === null ? null : sec.tot! - sec.van;
      // Ruim: faster-whisper op de CPU haalt ruwweg 5–10× realtime; een
      // hangend proces mag de opdracht niet blokkeren.
      const timeoutMs = Math.max(120, (duur ?? 3600) * instelling('BRON_TRANSCRIPTIE_TIJDFACTOR')) * 1000;
      let reden: string;
      try {
        if (sec.van === null) log('bron woordelijk transcriberen (hele video)…');
        const wav = join(werkmap, `b-${sec.van ?? 0}.wav`);
        await knipWav(bronPad, sec.van, sec.tot, wav);
        const ruw = await transcribeer(wav, model, timeoutMs);
        const op = ruw.map((w) => ({ w: w.w, s: Math.round((w.s + (sec.van ?? 0)) * 1000) / 1000, e: Math.round((w.e + (sec.van ?? 0)) * 1000) / 1000 }));
        if (op.length === 0) throw new Error('model gaf geen woorden terug');
        try {
          await cache.schrijf(sleutel, op);
        } catch (e) {
          log(`LET OP: transcriptiecache ${naam} niet opgeslagen (${(e as Error).message.slice(0, 80)}); volgende render transcribeert opnieuw`);
        }
        alle.push(...op);
        regels.push(`${naam} nieuw (${op.length})`);
        continue;
      } catch (e) {
        reden = (e as Error).message.replace(/\s+/g, ' ').slice(0, 160);
      }
      const terug = opties.transcript?.length ? groveWoorden(opties.transcript, sec.van ?? -Infinity, sec.tot ?? Infinity) : [];
      log(`transcriptie ${naam} mislukt: ${reden}${terug.length ? ` — terugval op het videotranscript (${terug.length} woorden, grof)` : ' — geen videotranscript om op terug te vallen'}`);
      alle.push(...terug);
      grof += terug.length;
      regels.push(`${naam} ${terug.length ? `grof (${terug.length})` : 'geen woorden'}`);
    }
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }
  alle.sort((x, y) => x.s - y.s);
  log(
    `brontranscriptie: ${secties.length} bereik(en)${bereiken.length ? ` rond ${bereiken.length} shot(s)` : ''} — ${regels.join(', ')}` +
      (grof ? ` ⚠ ${grof} grove woordtijden (knippen op woordgrenzen minder precies)` : ''),
  );
  return alle.length > 0 ? alle : null;
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
