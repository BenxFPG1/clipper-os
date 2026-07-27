import { runYtdlp } from '../ingest/youtube';
import { AccountPost } from './provider';

/**
 * Zoekt short-form video's op YouTube via yt-dlp. Dit is de gratis
 * research-backend: geen provider-key nodig, alleen de browsercookies die de
 * ingest toch al gebruikt. TikTok en Reels lopen via de scraping-provider.
 */
export async function searchYoutubeShorts(query: string, limit = 12): Promise<AccountPost[]> {
  const out = await runYtdlp(['--dump-single-json', `ytsearch${limit}:${query}`]);
  const json = JSON.parse(out) as { entries?: Record<string, unknown>[] };

  const posts: AccountPost[] = [];
  for (const entry of json.entries ?? []) {
    const duration = numberOf(entry.duration);
    // Research draait om short-form; lange video's (de bronafleveringen zelf)
    // horen in de ingest, niet in de discovery.
    if (duration !== null && duration > 240) continue;

    const views = numberOf(entry.view_count);
    const url = (entry.webpage_url as string | undefined) ?? (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null);
    if (!url) continue;

    posts.push({
      post_url: url,
      posted_at: parseUploadDate(entry.upload_date as string | undefined),
      views,
      likes: numberOf(entry.like_count),
      comments: numberOf(entry.comment_count),
      caption: (entry.title as string | undefined) ?? null,
      handle: (entry.channel as string | undefined) ?? (entry.uploader as string | undefined) ?? null,
      raw: {
        id: entry.id,
        duration,
        channel: entry.channel,
        channel_follower_count: entry.channel_follower_count,
      },
    });
  }
  return posts;
}

/** yt-dlp geeft upload_date als "20260715". */
function parseUploadDate(raw: string | undefined): string | null {
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
