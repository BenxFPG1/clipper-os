import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optionalEnv } from '../env';
import { resolveBinary } from './binaries';
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

/**
 * Transcribeert één audiobestand. Groq is het snelst maar vraagt een geldige
 * key (die begint met gsk_); staat die er niet, of faalt hij, dan draaien we
 * Whisper lokaal via faster-whisper. Dat is trager maar heeft geen key nodig
 * en werkt zowel op de Mac als op de GitHub-runner.
 */
async function transcribeFile(path: string): Promise<TranscriptSegment[]> {
  const apiKey = optionalEnv('GROQ_API_KEY');
  const bruikbareGroqKey = Boolean(apiKey && apiKey.startsWith('gsk_'));

  if (bruikbareGroqKey) {
    try {
      return await transcribeViaGroq(path, apiKey!);
    } catch (e) {
      console.warn(`[whisper] Groq faalde (${(e as Error).message.slice(0, 120)}), lokaal proberen`);
    }
  }
  return transcribeLokaal(path);
}

/**
 * Transcriberen zonder API-key. Twee wegen, in deze volgorde:
 * 1. whisper.cpp (`whisper-cli`) — native binary, snel op Apple Silicon.
 *    Installeren: brew install whisper-cpp
 * 2. faster-whisper via Python — wat de Linux-runner gebruikt.
 *    Installeren: pip3 install faster-whisper
 * Modelgrootte via WHISPER_LOKAAL_MODEL (standaard 'small').
 */
async function transcribeLokaal(path: string): Promise<TranscriptSegment[]> {
  try {
    return await transcribeViaWhisperCpp(path);
  } catch (e) {
    const bericht = (e as Error).message;
    // Ontbreekt de binary, dan is Python de volgende poging; faalt hij op iets
    // anders, dan is die melding het meest bruikbaar voor de gebruiker.
    if (!/ENOENT|niet geïnstalleerd|not found/i.test(bericht)) throw e;
  }
  return transcribeViaFasterWhisper(path);
}

/** whisper.cpp levert JSON met tijdcodes in milliseconden. */
async function transcribeViaWhisperCpp(path: string): Promise<TranscriptSegment[]> {
  const model = optionalEnv('WHISPER_LOKAAL_MODEL', 'small');
  const taal = optionalEnv('WHISPER_LANGUAGE', 'nl');
  const uitBasis = `${path}.wcpp`;

  // whisper.cpp wil 16 kHz mono WAV.
  const wav = `${path}.wav`;
  await run('ffmpeg', ['-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', wav]);

  await run('whisper-cli', [
    '-m', await modelPad(model),
    '-l', taal,
    '-oj',
    '-of', uitBasis,
    '-nt',
    // Zonder deze twee levert whisper.cpp blokken van 30 seconden; daar kun je
    // geen clip op knippen. Kort afbreken op woordgrenzen geeft segmenten van
    // een paar seconden, vergelijkbaar met YouTube-captions.
    '-ml', '70',
    '-sow',
    wav,
  ]);

  const json = JSON.parse(await readFile(`${uitBasis}.json`, 'utf8')) as {
    transcription?: { offsets?: { from: number; to: number }; text: string }[];
  };
  const rijen = json.transcription ?? [];
  if (rijen.length === 0) throw new Error('whisper.cpp gaf geen segmenten terug.');

  return rijen.map((r) => ({
    start_seconds: (r.offsets?.from ?? 0) / 1000,
    end_seconds: (r.offsets?.to ?? 0) / 1000,
    text: r.text.trim(),
  }));
}

/**
 * whisper.cpp heeft een modelbestand nodig. Ontbreekt het, dan halen we het
 * één keer op; anders faalt elke eerste run op een verse machine.
 */
async function modelPad(model: string): Promise<string> {
  const eigen = optionalEnv('WHISPER_MODEL_PAD');
  if (eigen) return eigen;

  const map = join(process.env.HOME ?? tmpdir(), '.cache', 'whisper-cpp');
  const pad = join(map, `ggml-${model}.bin`);
  try {
    await stat(pad);
    return pad;
  } catch {
    await mkdir(map, { recursive: true });
    const res = await fetch(
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`,
    );
    if (!res.ok) throw new Error(`Whisper-model ${model} downloaden mislukt (${res.status}).`);
    await writeFile(pad, Buffer.from(await res.arrayBuffer()));
    return pad;
  }
}

async function transcribeViaFasterWhisper(path: string): Promise<TranscriptSegment[]> {
  const model = optionalEnv('WHISPER_LOKAAL_MODEL', 'small');
  const taal = optionalEnv('WHISPER_LANGUAGE', 'nl');

  const script = `
import json, sys
try:
    from faster_whisper import WhisperModel
except ImportError:
    sys.stderr.write("faster-whisper ontbreekt. Installeer met: pip3 install faster-whisper")
    sys.exit(3)
model = WhisperModel(${JSON.stringify(model)}, device="cpu", compute_type="int8")
segments, _ = model.transcribe(sys.argv[1], language=${JSON.stringify(taal)}, vad_filter=True)
print(json.dumps([{"start": s.start, "end": s.end, "text": s.text} for s in segments]))
`;

  const uit = await run('python3', ['-c', script, path]);
  const rijen = JSON.parse(uit.trim().split('\n').pop() ?? '[]') as {
    start: number;
    end: number;
    text: string;
  }[];
  if (rijen.length === 0) {
    throw new Error('Lokale Whisper gaf geen segmenten terug.');
  }
  return rijen.map((s) => ({
    start_seconds: s.start,
    end_seconds: s.end,
    text: s.text.trim(),
  }));
}

async function transcribeViaGroq(path: string, apiKey: string): Promise<TranscriptSegment[]> {
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
  if (!res.ok) throw new Error(`Groq Whisper ${res.status}: ${(await res.text()).slice(0, 200)}`);

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
  // ffmpeg en ffprobe kennen alleen "-version"; yt-dlp wil "--version". Met de
  // verkeerde vlag faalt de check ook als de tool gewoon geïnstalleerd staat.
  const vlag = binary.startsWith('ff') ? '-version' : '--version';
  try {
    await run(binary, [vlag]);
  } catch {
    throw new MissingBinaryError(binary);
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
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exit ${code}: ${stderr.slice(-500)}`)),
    );
  });
}
