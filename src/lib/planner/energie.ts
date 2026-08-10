import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { ytdlpAuthArgs } from '../ingest/youtube';
import { TranscriptSegment } from '../ingest/transcript';
import { Energiemoment } from './schema';

/**
 * De oor-laag (bouwsteen A): de sterkste momenten van een gesprek zijn vaak
 * niet tekstueel — een stilte van vier seconden na een vraag, een lachsalvo,
 * een stem die zachter wordt. In een transcript is dat onzichtbaar; in de
 * audio staat het gewoon. Dit meet drie dingen, puur mechanisch:
 *
 * - stiltes: pauzes die geen zinseinde zijn (spanning, een schok, een lach
 *   die stilvalt).
 * - volumepieken: audio die opvallend luider is dan de omgeving (lach, een
 *   uitroep, een stem die aanzet).
 * - tempowisselingen: uit het transcript zelf — woorden per seconde die
 *   plots omhoog of omlaag schieten.
 *
 * Best-effort: zonder bronvideo, zonder ffmpeg/yt-dlp, of bij een fout levert
 * dit gewoon een lege (of gedeeltelijke) lijst. De planner draait er zonder
 * evengoed, alleen zonder deze extra laag — nooit een reden om te falen.
 */

const STILTE_DREMPEL_DB = -32;
const STILTE_MIN_DUUR = 1.8;
const PIEK_DREMPEL_DB = -16;
const PIEK_MIN_DUUR = 0.35;

/** Hoeveel momenten er hoogstens meegaan de prompt in; anders wordt hij te lang. */
const MAX_MOMENTEN = 40;

export async function mijnEnergie(
  sourceUrl: string | null,
  transcript: TranscriptSegment[],
): Promise<Energiemoment[]> {
  const momenten: Energiemoment[] = [...tempowisselingen(transcript)];

  if (sourceUrl) {
    try {
      momenten.push(...(await audioMomenten(sourceUrl)));
    } catch (e) {
      console.warn('[energie] audioanalyse overgeslagen:', (e as Error).message);
    }
  }

  return momenten
    .sort((a, b) => b.sterkte - a.sterkte)
    .slice(0, MAX_MOMENTEN)
    .sort((a, b) => a.start - b.start);
}

/** Compact voor in de character-map-prompt; leeg blok als er niets gemeten is. */
export function renderEnergie(momenten: Energiemoment[]): string {
  if (momenten.length === 0) return '';
  const regel = (m: Energiemoment) =>
    `[${Math.round(m.start)}-${Math.round(m.end)}] ${m.soort} (sterkte ${m.sterkte.toFixed(2)})`;
  return `\n\nENERGIE VAN HET GESPREK (mechanisch gemeten, geen oordeel — gebruik dit om vondsten te vinden of te onderbouwen die in de tekst alleen niet opvallen):\n${momenten
    .map(regel)
    .join('\n')}`;
}

/**
 * Rolt over het transcript met een venster van ~8 seconden en vergelijkt het
 * lokale spreektempo (woorden/seconde) met het mediaan-tempo van de hele
 * video. Een sterke afwijking, minstens 3 seconden aangehouden, is een
 * tempowisseling: iemand versnelt (opwinding, haast) of valt stil (schok,
 * nadenken, gewicht geven aan een zin).
 */
function tempowisselingen(transcript: TranscriptSegment[]): Energiemoment[] {
  if (transcript.length < 6) return [];

  const venster = 8;
  const punten: { t: number; wps: number }[] = [];
  const totaleDuur = transcript[transcript.length - 1]?.end_seconds ?? 0;

  for (let t = 0; t < totaleDuur; t += 2) {
    const in_venster = transcript.filter((s) => s.start_seconds < t + venster && s.end_seconds > t);
    const woorden = in_venster.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    const dekking = in_venster.reduce(
      (sec, s) => sec + Math.min(s.end_seconds, t + venster) - Math.max(s.start_seconds, t),
      0,
    );
    if (dekking > 1) punten.push({ t: t + venster / 2, wps: woorden / dekking });
  }
  if (punten.length < 4) return [];

  const alleWps = [...punten.map((p) => p.wps)].sort((a, b) => a - b);
  const mediaan = alleWps[Math.floor(alleWps.length / 2)] ?? 0;
  if (mediaan <= 0) return [];

  const momenten: Energiemoment[] = [];
  let lopend: { start: number; eind: number; richting: 'op' | 'neer' } | null = null;

  for (const p of punten) {
    const afwijking = p.wps / mediaan;
    const richting: 'op' | 'neer' | null = afwijking > 1.6 ? 'op' : afwijking < 0.5 ? 'neer' : null;

    if (richting && lopend && lopend.richting === richting) {
      lopend.eind = p.t;
    } else {
      if (lopend && lopend.eind - lopend.start >= 3) {
        momenten.push({
          soort: 'tempowisseling',
          start: lopend.start,
          end: lopend.eind,
          sterkte: lopend.richting === 'op' ? 0.6 : 0.75,
        });
      }
      lopend = richting ? { start: p.t, eind: p.t, richting } : null;
    }
  }
  if (lopend && lopend.eind - lopend.start >= 3) {
    momenten.push({
      soort: 'tempowisseling',
      start: lopend.start,
      end: lopend.eind,
      sterkte: lopend.richting === 'op' ? 0.6 : 0.75,
    });
  }
  return momenten;
}

/**
 * Downloadt alleen de audio (klein, snel) en haalt er twee dingen uit met
 * dezelfde beproefde ffmpeg-primitief (silencedetect), op twee drempels:
 * laag voor echte stiltes, hoog voor uitschieters naar boven (silencedetect
 * rapporteert dan alles ónder -16dB als "stilte" — het omgekeerde, de gaten
 * ertussen, zijn de momenten die daar wél bovenuit komen).
 */
async function audioMomenten(sourceUrl: string): Promise<Energiemoment[]> {
  await assertBinaryBeschikbaar('yt-dlp');
  await assertBinaryBeschikbaar('ffmpeg');

  const workdir = await mkdtemp(join(tmpdir(), 'clipper-energie-'));
  try {
    const audioPath = join(workdir, 'audio.m4a');
    await run('yt-dlp', [
      ...ytdlpAuthArgs(),
      '-f',
      'bestaudio/best',
      '-x',
      '--audio-format',
      'm4a',
      '--postprocessor-args',
      'ffmpeg:-ac 1 -ar 16000 -b:a 32k',
      '-o',
      audioPath,
      '--no-warnings',
      sourceUrl,
    ]);

    const [stiltes, pieken] = await Promise.all([
      silenceRanges(audioPath, STILTE_DREMPEL_DB, STILTE_MIN_DUUR),
      // Bij een hoge drempel is "silence" alles behalve de uitschieters; de
      // gaten tussen twee silence-vensters zijn dus de pieken zelf.
      silenceRanges(audioPath, PIEK_DREMPEL_DB, 0.05).then((stil) => gatenTussen(stil, PIEK_MIN_DUUR)),
    ]);

    return [
      ...stiltes.map((r) => ({
        soort: 'stilte' as const,
        start: r.start,
        end: r.end,
        sterkte: Math.min(1, (r.end - r.start) / 5),
      })),
      ...pieken.map((r) => ({
        soort: 'volumepiek' as const,
        start: r.start,
        end: r.end,
        sterkte: Math.min(1, 0.5 + (r.end - r.start) / 4),
      })),
    ];
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/** Vensters ónder de drempel via ffmpeg's silencedetect-filter. */
async function silenceRanges(
  audioPath: string,
  drempelDb: number,
  minDuur: number,
): Promise<{ start: number; end: number }[]> {
  const stderr = await run('ffmpeg', [
    '-i',
    audioPath,
    '-af',
    `silencedetect=noise=${drempelDb}dB:d=${minDuur}`,
    '-f',
    'null',
    '-',
  ]);

  const ranges: { start: number; end: number }[] = [];
  let openStart: number | null = null;
  for (const regel of stderr.split('\n')) {
    const startMatch = regel.match(/silence_start:\s*(-?[\d.]+)/);
    if (startMatch) {
      openStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = regel.match(/silence_end:\s*(-?[\d.]+)/);
    if (endMatch && openStart !== null) {
      ranges.push({ start: openStart, end: Number(endMatch[1]) });
      openStart = null;
    }
  }
  return ranges;
}

/** De niet-stille gaten tussen opeenvolgende stille vensters, minstens `minDuur` lang. */
function gatenTussen(stil: { start: number; end: number }[], minDuur: number): { start: number; end: number }[] {
  const gesorteerd = [...stil].sort((a, b) => a.start - b.start);
  const gaten: { start: number; end: number }[] = [];
  for (let i = 0; i < gesorteerd.length - 1; i++) {
    const van = gesorteerd[i].end;
    const tot = gesorteerd[i + 1].start;
    if (tot - van >= minDuur) gaten.push({ start: van, end: tot });
  }
  return gaten;
}

async function assertBinaryBeschikbaar(binary: string): Promise<void> {
  const vlag = binary.startsWith('ff') ? '-version' : '--version';
  try {
    await run(binary, [vlag]);
  } catch {
    throw new Error(`${binary} niet beschikbaar; energiemijnbouw overgeslagen.`);
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveBinary(command), args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout + stderr) : reject(new Error(`${command} exit ${code}`))));
  });
}
