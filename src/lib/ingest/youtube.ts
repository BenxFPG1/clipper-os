import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optionalEnv } from '../env';
import { resolveBinary } from './binaries';
import { TranscriptSegment, closeOpenEnds } from './transcript';

export type YoutubeCaptions = {
  segments: TranscriptSegment[];
  title: string | null;
  durationSeconds: number | null;
};

export function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/(?:embed|shorts|live)\/)([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return /^[\w-]{11}$/.test(url.trim()) ? url.trim() : null;
}

/**
 * YouTube blokkeert anonieme requests met een bot-check. yt-dlp lost dat op met
 * cookies uit een lokale browser. Zet YTDLP_COOKIES_FROM_BROWSER op bijvoorbeeld
 * "chrome" om dat aan te zetten; zonder die var proberen we het zonder cookies
 * en krijg je een duidelijke foutmelding als YouTube weigert.
 */
export function ytdlpAuthArgs(): string[] {
  const browser = optionalEnv('YTDLP_COOKIES_FROM_BROWSER');
  if (browser) return ['--cookies-from-browser', browser];
  const cookieFile = optionalEnv('YTDLP_COOKIES_FILE');
  if (cookieFile) return ['--cookies', cookieFile];
  return [];
}

export class YoutubeBlockedError extends Error {
  constructor(detail: string) {
    super(
      `YouTube blokkeert de aanvraag (bot-check). Zet YTDLP_COOKIES_FROM_BROWSER=chrome in .env ` +
        `zodat yt-dlp je browsercookies gebruikt. Origineel: ${detail}`,
    );
    this.name = 'YoutubeBlockedError';
  }
}

/**
 * Haalt captions op via yt-dlp in json3-formaat (dat heeft tijdcodes per
 * segment). Voorkeur: handmatige Nederlandse ondertiteling, dan Engels, dan
 * automatische. Geeft null als er niets bruikbaars is; de ingest valt dan terug
 * op zelf transcriberen.
 */
export async function fetchYoutubeCaptions(url: string): Promise<YoutubeCaptions | null> {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error(`Geen geldige YouTube-URL of video-id: ${url}`);

  const workdir = await mkdtemp(join(tmpdir(), 'clipper-subs-'));
  try {
    const meta = await fetchMetadata(url);

    await runYtdlp([
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      optionalEnv('YTDLP_SUB_LANGS', 'nl,nl-orig,en'),
      '--sub-format',
      'json3',
      '-o',
      join(workdir, 'sub'),
      url,
    ]);

    const files = (await readdir(workdir)).filter((f) => f.endsWith('.json3'));
    if (files.length === 0) return null;

    // Handmatige ondertiteling gaat voor automatische; die laatste heeft ".orig"
    // noch een taalvariant in de naam die we kunnen onderscheiden, dus we sorteren
    // op taalvoorkeur en nemen de eerste.
    const preferred = ['nl', 'nl-orig', 'en'];
    files.sort((a, b) => rank(a, preferred) - rank(b, preferred));

    const raw = await readFile(join(workdir, files[0]), 'utf8');
    const segments = parseJson3(raw);
    if (segments.length === 0) return null;

    return {
      segments: closeOpenEnds(mergeShortSegments(segments)),
      title: meta.title,
      durationSeconds: meta.duration,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function fetchMetadata(url: string): Promise<{ title: string | null; duration: number | null }> {
  const out = await runYtdlp(['--dump-single-json', '--skip-download', url]);
  const info = JSON.parse(out) as { title?: string; duration?: number };
  return { title: info.title ?? null, duration: info.duration ?? null };
}

function rank(filename: string, preferred: string[]): number {
  const match = filename.match(/\.([\w-]+)\.json3$/);
  const lang = match?.[1] ?? '';
  const index = preferred.indexOf(lang);
  return index === -1 ? preferred.length : index;
}

/** json3 is YouTube's eigen ondertitelformaat: events met start, duur en tekstdelen. */
export function parseJson3(raw: string): TranscriptSegment[] {
  const json = JSON.parse(raw) as {
    events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[];
  };

  const segments: TranscriptSegment[] = [];
  for (const event of json.events ?? []) {
    const text = (event.segs ?? [])
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || event.tStartMs === undefined) continue;
    const start = event.tStartMs / 1000;
    segments.push({
      start_seconds: start,
      end_seconds: start + (event.dDurationMs ?? 0) / 1000,
      text,
    });
  }
  return segments;
}

/**
 * Auto-captions komen in fragmenten van een paar woorden binnen. Dat kost
 * onnodig veel tokens en maakt de tijdcodes onbruikbaar; we plakken ze tot
 * zinnen van ongeveer 8 seconden.
 */
function mergeShortSegments(segments: TranscriptSegment[], targetSeconds = 8): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && seg.end_seconds - last.start_seconds <= targetSeconds) {
      last.text = `${last.text} ${seg.text}`.trim();
      last.end_seconds = seg.end_seconds;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

export function runYtdlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveBinary('yt-dlp'), [...ytdlpAuthArgs(), '--no-warnings', ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', () =>
      reject(new Error('yt-dlp is niet geïnstalleerd. Installeer met: brew install yt-dlp ffmpeg')),
    );
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout);
      if (/Sign in to confirm|bot|cookies/i.test(stderr)) return reject(new YoutubeBlockedError(stderr.trim().slice(-300)));
      reject(new Error(`yt-dlp exit ${code}: ${stderr.trim().slice(-300)}`));
    });
  });
}
