import { runYtdlp } from '../ingest/youtube';
import { AccountPost, Platform, PostMetrics } from './provider';

/**
 * Gratis social-backend via yt-dlp met browsercookies. Dekt wat yt-dlp aankan:
 * - TikTok: profielen en losse video's (views, likes, comments)
 * - YouTube/Shorts: kanalen, losse video's en zoeken
 * - Instagram: NIET — de extractor is upstream kapot; daar blijft de
 *   scraping-provider voor nodig.
 */

/** Recente posts van een TikTok-profiel, met viewcounts, zonder API-key. */
export async function fetchTiktokAccountPosts(handle: string, limit = 30): Promise<AccountPost[]> {
  const clean = handle.replace(/^@/, '');
  const out = await runYtdlp([
    '--flat-playlist',
    '--dump-json',
    '-I',
    `1:${limit}`,
    `https://www.tiktok.com/@${clean}`,
  ]);
  return parseNdjson(out).map((entry) => ({
    post_url:
      (entry.original_url as string | undefined) ??
      `https://www.tiktok.com/@${clean}/video/${entry.id}`,
    posted_at: tiktokIdToDate(entry.id as string | undefined),
    views: numberOf(entry.view_count),
    likes: numberOf(entry.like_count),
    comments: numberOf(entry.comment_count),
    caption: (entry.description as string | undefined) ?? (entry.title as string | undefined) ?? null,
    handle: (entry.channel as string | undefined) ?? clean,
    raw: { id: entry.id, duration: entry.duration, repost_count: entry.repost_count },
  }));
}

/** Recente shorts van een YouTube-kanaal, zonder API-key. */
export async function fetchYoutubeChannelShorts(handle: string, limit = 30): Promise<AccountPost[]> {
  const clean = handle.replace(/^@/, '');
  const out = await runYtdlp([
    '--flat-playlist',
    '--dump-json',
    '-I',
    `1:${limit}`,
    `https://www.youtube.com/@${clean}/shorts`,
  ]);
  return parseNdjson(out).map((entry) => ({
    post_url: (entry.url as string | undefined) ?? `https://www.youtube.com/shorts/${entry.id}`,
    posted_at: null, // flat listing van YouTube geeft geen uploaddatum; voor account-outliers is views/mediaan genoeg
    views: numberOf(entry.view_count),
    likes: numberOf(entry.like_count),
    comments: numberOf(entry.comment_count),
    caption: (entry.title as string | undefined) ?? null,
    handle: clean,
    raw: { id: entry.id, duration: entry.duration },
  }));
}

/** Metingen van één post (TikTok of YouTube), zonder API-key. */
export async function fetchVideoMetricsViaYtdlp(postUrl: string): Promise<PostMetrics> {
  const out = await runYtdlp(['--dump-single-json', '--no-playlist', postUrl]);
  const json = JSON.parse(out) as Record<string, unknown>;
  return {
    views: numberOf(json.view_count),
    likes: numberOf(json.like_count),
    comments: numberOf(json.comment_count),
    shares: numberOf(json.repost_count),
    raw: {
      id: json.id,
      title: json.title,
      view_count: json.view_count,
      like_count: json.like_count,
      comment_count: json.comment_count,
      repost_count: json.repost_count,
      uploader: json.uploader,
      upload_date: json.upload_date,
    },
  };
}

export function ytdlpSupports(platform: Platform): boolean {
  return platform === 'tiktok' || platform === 'shorts';
}

/**
 * De eerste 32 bits van een TikTok-video-id zijn de unix-timestamp van het
 * moment van posten. Zo hebben we een posttijd zonder extra request.
 */
export function tiktokIdToDate(id: string | undefined): string | null {
  if (!id || !/^\d{15,20}$/.test(id)) return null;
  const seconds = Number(BigInt(id) >> 32n);
  if (seconds < 1.3e9 || seconds > Date.now() / 1000 + 86400) return null;
  return new Date(seconds * 1000).toISOString();
}

function parseNdjson(out: string): Record<string, unknown>[] {
  return out
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
