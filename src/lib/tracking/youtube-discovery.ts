import { runYtdlp } from '../ingest/youtube';
import { AccountPost } from './provider';

/**
 * Zoekt short-form video's op YouTube via yt-dlp. Dit is de gratis
 * research-backend: geen provider-key nodig, alleen de browsercookies die de
 * ingest toch al gebruikt.
 *
 * We gebruiken de flat listing van een zoek-URL met het filter "deze week".
 * Dat is één paginafetch in plaats van een metadata-fetch per video (die door
 * YouTube's JS-challenges ruim een minuut per video kan kosten), en het filter
 * doet meteen het Sandcastles-werk: alleen verse posts, zodat ruwe views een
 * eerlijke maat zijn en we geen uploaddatum per video nodig hebben.
 */
export async function searchYoutubeShorts(query: string, limit = 25): Promise<AccountPost[]> {
  // sp=EgIIAw%3D%3D is YouTube's eigen "upload deze week"-filter.
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIIAw%3D%3D`;
  return flatListing(url, limit);
}

/**
 * Wat er nu platformbreed goed loopt op YouTube, los van accounts of
 * zoektermen: de trending-feed. Mainstream, maar precies daarom nuttig — de
 * scout decodeert wat er patroonmatig werkt en de retro filtert wat voor ons
 * materiaal relevant is.
 */
export async function fetchYoutubeTrendingShorts(limit = 30): Promise<AccountPost[]> {
  return flatListing('https://www.youtube.com/feed/trending', limit);
}

async function flatListing(url: string, limit: number): Promise<AccountPost[]> {
  const out = await runYtdlp(['--flat-playlist', '--dump-json', '-I', `1:${limit}`, url]);

  const posts: AccountPost[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    const entry = JSON.parse(line) as Record<string, unknown>;

    const duration = numberOf(entry.duration);
    // Research draait om short-form; lange video's (de bronafleveringen zelf)
    // horen in de ingest, niet in de discovery.
    if (duration !== null && duration > 240) continue;

    const views = numberOf(entry.view_count);
    if (views === null) continue;

    const id = entry.id as string | undefined;
    const link = (entry.url as string | undefined) ?? (id ? `https://www.youtube.com/watch?v=${id}` : null);
    if (!link) continue;

    posts.push({
      post_url: link,
      // Flat listings geven geen uploaddatum; deze feeds zijn per definitie
      // vers, dus views alleen zijn binnen de set vergelijkbaar.
      posted_at: null,
      views,
      likes: numberOf(entry.like_count),
      comments: numberOf(entry.comment_count),
      caption: (entry.title as string | undefined) ?? null,
      handle: (entry.channel as string | undefined) ?? (entry.uploader as string | undefined) ?? null,
      raw: { id, duration, channel: entry.channel },
    });
  }
  return posts;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
