import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optionalEnv, requireEnv } from '../env';
import { TranscriptSegment, closeOpenEnds } from './transcript';
import { ytdlpAuthArgs } from './youtube';

/**
 * Groq accepteert bestanden tot 25 MB (gratis tier). Op 32 kbps mono is dat
 * ruim 100 minuten audio, dus voor onze bronvideo's zit één bestand er meestal
 * in. Langere video's knippen we in stukken en plakken we weer aan elkaar.
 */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const CHUNK_SECONDS = 20 * 60;
const WHISPER_MODEL = 'whisper-large-v3';

export class MissingBinaryError extends Error {
  constructor(readonly binary: string) {
    super(
      `${binary} is niet geïnstalleerd. Installeer met: brew install yt-dlp ffmpeg. ` +
        `Zonder deze tools kan de tool geen eigen transcript bouwen; plak dan het transcript handmatig.`,
    );
    this.name = 'MissingBinaryError';
  }
}

export type TranscriptionResult = {
  segments: TranscriptSegment[];
  title: string | null;
  durationSeconds: number | null;
};

/**
 * Bouwt zelf een transcript voor een YouTube-URL: audio downloaden, omzetten
 * naar 16 kHz mono (meer heeft Whisper niet nodig en het scheelt uploadtijd),
 * en per stuk transcriberen. Wordt gebruikt als er geen captions zijn.
 */
export async function transcribeYoutube(url: string): Promise<TranscriptionResult> {
  await assertBinary('yt-dlp');
  await assertBinary('ffmpeg');

  const workdir = await mkdtemp(join(tmpdir(), 'clipper-audio-'));
  try {
    const audioPath = join(workdir, 'audio.m4a');
    const meta = await downloadAudio(url, audioPath);
    const chunks = await splitIfNeeded(audioPath, workdir, meta.durationSeconds);

    const segments: TranscriptSegment[] = [];
    for (const chunk of chunks) {
      const part = await transcribeFile(chunk.path);
      for (const seg of part) {
        segments.push({
          start_seconds: seg.start_seconds + chunk.offsetSeconds,
          end_seconds: seg.end_seconds + chunk.offsetSeconds,
          text: seg.text,
        });
      }
    }

    return {
      segments: closeOpenEnds(segments.sort((a, b) => a.start_seconds - b.start_seconds)),
      title: meta.title,
      durationSeconds: meta.durationSeconds,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/** Transcribeert een audiobestand dat al op schijf staat. */
export async function transcribeLocalFile(path: string): Promise<TranscriptSegment[]> {
  await assertBinary('ffmpeg');
  const workdir = await mkdtemp(join(tmpdir(), 'clipper-audio-'));
  try {
    const converted = join(workdir, 'audio.m4a');
    await run('ffmpeg', ['-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', converted]);
    const duration = await probeDuration(converted);
    const chunks = await splitIfNeeded(converted, workdir, duration);

    const segments: TranscriptSegment[] = [];
    for (const chunk of chunks) {
      const part = await transcribeFile(chunk.path);
      for (const seg of part) {
        segments.push({
          start_seconds: seg.start_seconds + chunk.offsetSeconds,
          end_seconds: seg.end_seconds + chunk.offsetSeconds,
          text: seg.text,
        });
      }
    }
    return closeOpenEnds(segments.sort((a, b) => a.start_seconds - b.start_seconds));
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function downloadAudio(url: string, outPath: string) {
  const auth = ytdlpAuthArgs();
  const infoRaw = await run('yt-dlp', [...auth, '--dump-single-json', '--no-warnings', '--skip-download', url]);
  const info = JSON.parse(infoRaw) as { title?: string; duration?: number };

  await run('yt-dlp', [
    ...auth,
    '-f',
    'bestaudio/best',
    '-x',
    '--audio-format',
    'm4a',
    // 16 kHz mono op 32 kbps: Whisper-kwaliteit blijft gelijk, bestand wordt klein.
    '--postprocessor-args',
    'ffmpeg:-ac 1 -ar 16000 -b:a 32k',
    '-o',
    outPath,
    '--no-warnings',
    url,
  ]);

  return { title: info.title ?? null, durationSeconds: info.duration ?? (await probeDuration(outPath)) };
}

type Chunk = { path: string; offsetSeconds: number };

async function splitIfNeeded(audioPath: string, workdir: string, durationSeconds: number | null): Promise<Chunk[]> {
  const { size } = await stat(audioPath);
  if (size <= MAX_UPLOAD_BYTES) return [{ path: audioPath, offsetSeconds: 0 }];

  const duration = durationSeconds ?? (await probeDuration(audioPath));
  if (!duration) throw new Error('Audio is te groot en de duur is niet te bepalen; kan niet opsplitsen.');

  const chunks: Chunk[] = [];
  for (let offset = 0; offset < duration; offset += CHUNK_SECONDS) {
    const path = join(workdir, `chunk-${offset}.m4a`);
    await run('ffmpeg', [
      '-y',
      '-i', audioPath,
      '-ss', String(offset),
      '-t', String(CHUNK_SECONDS),
      '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
      path,
    ]);
    chunks.push({ path, offsetSeconds: offset });
  }
  return chunks;
}

async function transcribeFile(path: string): Promise<TranscriptSegment[]> {
  const apiKey = requireEnv('GROQ_API_KEY');
  const buffer = await readFile(path);

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: 'audio/m4a' }), 'audio.m4a');
  form.append('model', optionalEnv('WHISPER_MODEL', WHISPER_MODEL));
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('language', optionalEnv('WHISPER_LANGUAGE', 'nl'));

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq Whisper ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    segments?: { start: number; end: number; text: string }[];
    text?: string;
  };

  if (!json.segments?.length) {
    // Zonder segmenten hebben we geen tijdcodes en dus geen bruikbaar plan.
    throw new Error('Whisper gaf geen segmenten terug; transcript zonder tijdcodes is onbruikbaar.');
  }

  return json.segments.map((s) => ({
    start_seconds: s.start,
    end_seconds: s.end,
    text: s.text.trim(),
  }));
}

async function probeDuration(path: string): Promise<number | null> {
  try {
    const out = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ]);
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function assertBinary(binary: string): Promise<void> {
  try {
    await run(binary, ['--version']);
  } catch {
    throw new MissingBinaryError(binary);
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exit ${code}: ${stderr.slice(-500)}`)),
    );
  });
}
