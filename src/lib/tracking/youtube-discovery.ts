import { optionalEnv } from '../env';
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
 * Wat er nu platformbreed goed loopt op YouTube, los van gevolgde accounts of
 * eigen zoektermen. YouTube heeft zijn trending-pagina in 2025 opgeheven, dus
 * we stellen dezelfde vraag via de zoekfilters: geüpload deze week, gesorteerd
 * op views (sp=CAMSBAgDEAE=), over een paar brede NL-termen. Aanpasbaar via
 * DISCOVERY_TRENDING_QUERIES (kommagescheiden).
 */
export async function fetchYoutubeTrendingShorts(limit = 30): Promise<AccountPost[]> {
  const queries = optionalEnv('DISCOVERY_TRENDING_QUERIES', 'nederland,nederlands,nederlandse podcast')
    .split(',')
    .map((q) => q.trim())
    .filter(Boolean);

  const perQuery = Math.max(8, Math.ceil(limit / queries.length));
  const posts: AccountPost[] = [];
  for (const query of queries) {
    // sp=CAMSBggDEAEYAQ== : deze week + korter dan 4 minuten + gesorteerd op views.
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=CAMSBggDEAEYAQ%3D%3D`;
    posts.push(...(await flatListing(url, perQuery)));
  }

  const seen = new Set<string>();
  return posts.filter((p) => {
    if (seen.has(p.post_url)) return false;
    seen.add(p.post_url);
    return true;
  });
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
      // Het @-handle (uploader_id) of het kanaal-id, niet de weergavenaam:
      // "ESPN NL" is geen adres dat yt-dlp kan volgen, "@espnnl" wel. De
      // weergavenaam-varianten vulden de volglijst met dubbele, onmeetbare
      // accounts.
      handle: youtubeHandle(entry),
      raw: { id, duration, channel: entry.channel },
    });
  }
  return posts;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @handle (zonder @) > kanaal-id (UC…) > weergavenaam, in die volgorde van bruikbaarheid. */
export function youtubeHandle(entry: Record<string, unknown>): string | null {
  const uploaderId = entry.uploader_id;
  if (typeof uploaderId === 'string' && uploaderId.startsWith('@')) return uploaderId.slice(1);
  const uploaderUrl = entry.uploader_url ?? entry.channel_url;
  if (typeof uploaderUrl === 'string') {
    const m = uploaderUrl.match(/youtube\.com\/@([^/?#]+)/);
    if (m) return m[1];
  }
  const channelId = entry.channel_id;
  if (typeof channelId === 'string' && /^UC[\w-]{20,}$/.test(channelId)) return channelId;
  return (entry.channel as string | undefined) ?? (entry.uploader as string | undefined) ?? null;
}
