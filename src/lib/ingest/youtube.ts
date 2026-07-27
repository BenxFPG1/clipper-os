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
 * Haalt de officiele captions op via de timedtext-endpoint die de watch-pagina
 * zelf gebruikt. Geen scraping-provider nodig, maar ook geen garantie: video's
 * zonder captions geven null terug en dan valt de ingest terug op Whisper of
 * een handmatige upload.
 */
export async function fetchYoutubeCaptions(url: string): Promise<YoutubeCaptions | null> {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error(`Geen geldige YouTube-URL of video-id: ${url}`);

  const page = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'nl,en;q=0.8' },
  });
  if (!page.ok) throw new Error(`YouTube-pagina niet op te halen (${page.status})`);
  const html = await page.text();

  const title = decodeEntities(html.match(/<meta name="title" content="([^"]*)"/)?.[1] ?? '') || null;
  const durationRaw = html.match(/"lengthSeconds":"(\d+)"/)?.[1];
  const durationSeconds = durationRaw ? Number(durationRaw) : null;

  const tracks = findCaptionTracks(html);
  if (tracks.length === 0) return null;

  // Voorkeur: Nederlands, dan Engels, dan wat er is. Auto-generated is prima.
  const track =
    tracks.find((t) => t.languageCode.startsWith('nl')) ??
    tracks.find((t) => t.languageCode.startsWith('en')) ??
    tracks[0];

  const res = await fetch(`${track.baseUrl}&fmt=json3`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;

  const json = (await res.json()) as {
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

  if (segments.length === 0) return null;
  return { segments: closeOpenEnds(mergeShortSegments(segments)), title, durationSeconds };
}

type CaptionTrack = { baseUrl: string; languageCode: string };

function findCaptionTracks(html: string): CaptionTrack[] {
  const raw = html.match(/"captionTracks":(\[.*?\])/s)?.[1];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.replace(/\\u0026/g, '&')) as CaptionTrack[];
    return parsed.filter((t) => t.baseUrl);
  } catch {
    return [];
  }
}

/**
 * Auto-captions komen in fragmenten van 1-2 woorden binnen. Dat kost onnodig
 * veel tokens en maakt de tijdcodes onbruikbaar; we plakken ze tot zinnen van
 * ongeveer 8 seconden.
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

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
