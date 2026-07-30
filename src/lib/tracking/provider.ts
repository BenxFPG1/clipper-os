import { optionalEnv, requireEnv } from '../env';

export type PostMetrics = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  raw: unknown;
};

export type Platform = 'tiktok' | 'reels' | 'shorts';

/** Eén post zoals de Scout-agent hem tegenkomt, via een account of een zoekterm. */
export type AccountPost = {
  post_url: string;
  posted_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  caption: string | null;
  /** Wie hem plaatste, als de bron dat meegeeft. */
  handle: string | null;
  raw: unknown;
};

/**
 * Eén interface voor alle scraping-providers, zodat ScrapeCreators en Apify
 * uitwisselbaar zijn (sectie 13: provider-afhankelijkheid).
 */
export interface MetricsProvider {
  readonly name: string;
  /** Geschatte credits/kosten in euro per call, voor de kostenbewaking. */
  readonly costPerCallEur: number;
  fetchPostMetrics(postUrl: string, platform: Platform): Promise<PostMetrics>;
  /** Recente posts van een account — de basis voor de Scout-agent. */
  fetchAccountPosts(handle: string, platform: Platform, limit?: number): Promise<AccountPost[]>;
  /** Zoekt posts op de platforms zelf op een zoekterm — de research-kant. */
  searchPosts(query: string, platform: Platform, limit?: number): Promise<AccountPost[]>;
  /** Wat er platformbreed trending is, los van accounts of zoektermen. */
  fetchTrending(platform: Platform, limit?: number): Promise<AccountPost[]>;
  /** Uitgesproken tekst van een post, met tijdcodes. Null als niet beschikbaar. */
  fetchTranscript?(postUrl: string, platform: Platform): Promise<string | null>;
}

export function detectPlatform(postUrl: string): Platform | null {
  if (/tiktok\.com/i.test(postUrl)) return 'tiktok';
  if (/instagram\.com/i.test(postUrl)) return 'reels';
  if (/youtube\.com|youtu\.be/i.test(postUrl)) return 'shorts';
  return null;
}

/** Hoeveel pagina's we maximaal ophalen per account; elke pagina kost een credit. */
const MAX_PAGINAS = 3;

class ScrapeCreatorsProvider implements MetricsProvider {
  readonly name = 'scrapecreators';
  readonly costPerCallEur = 0.002;

  async fetchPostMetrics(postUrl: string, platform: Platform): Promise<PostMetrics> {
    const endpoint: Record<Platform, string> = {
      tiktok: 'https://api.scrapecreators.com/v1/tiktok/video',
      reels: 'https://api.scrapecreators.com/v1/instagram/post',
      shorts: 'https://api.scrapecreators.com/v1/youtube/video',
    };

    const url = new URL(endpoint[platform]);
    url.searchParams.set('url', postUrl);

    const res = await fetch(url, { headers: { 'x-api-key': requireEnv('SCRAPECREATORS_API_KEY') } });
    if (!res.ok) throw new Error(`ScrapeCreators ${res.status}: ${await res.text()}`);

    const raw = (await res.json()) as Record<string, unknown>;
    return { ...normalizeMetrics(raw), raw };
  }

  async fetchAccountPosts(handle: string, platform: Platform, limit = 30): Promise<AccountPost[]> {
    const endpoint: Record<Platform, string> = {
      tiktok: 'https://api.scrapecreators.com/v3/tiktok/profile/videos',
      reels: 'https://api.scrapecreators.com/v2/instagram/user/posts',
      shorts: 'https://api.scrapecreators.com/v1/youtube/channel/videos',
    };

    // Eén pagina levert er ongeveer tien. Te weinig voor een betrouwbare
    // mediaan: met drie virale hits tussen zeven gewone posts krijg je scores
    // van 190x die meer over de steekproef zeggen dan over het account. We
    // pagineren dus door tot we genoeg posts hebben.
    const posts: AccountPost[] = [];
    let cursor: string | null = null;

    for (let pagina = 0; pagina < MAX_PAGINAS && posts.length < limit; pagina++) {
      const url = new URL(endpoint[platform]);
      url.searchParams.set('handle', handle.replace(/^@/, ''));
      url.searchParams.set('amount', String(limit));
      if (cursor) url.searchParams.set('max_cursor', cursor);

      const res = await fetch(url, { headers: { 'x-api-key': requireEnv('SCRAPECREATORS_API_KEY') } });
      if (!res.ok) {
        if (pagina === 0) throw new Error(`ScrapeCreators ${res.status}: ${await res.text()}`);
        break;
      }

      const json = (await res.json()) as Record<string, unknown>;
      const batch = normalizePosts(json, platform, handle);
      if (batch.length === 0) break;

      posts.push(...batch);

      const meer = json.has_more;
      const volgende = json.max_cursor ?? json.next_cursor;
      if (!meer || volgende === undefined || volgende === null) break;
      cursor = String(volgende);
    }

    return posts.slice(0, limit);
  }

  async searchPosts(query: string, platform: Platform, limit = 30): Promise<AccountPost[]> {
    const endpoint: Record<Platform, string> = {
      tiktok: 'https://api.scrapecreators.com/v1/tiktok/search/keyword',
      reels: 'https://api.scrapecreators.com/v1/instagram/search/hashtag',
      shorts: 'https://api.scrapecreators.com/v1/youtube/search',
    };

    const url = new URL(endpoint[platform]);
    url.searchParams.set('query', query);
    url.searchParams.set('amount', String(limit));

    const res = await fetch(url, { headers: { 'x-api-key': requireEnv('SCRAPECREATORS_API_KEY') } });
    if (!res.ok) throw new Error(`ScrapeCreators ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as Record<string, unknown>;
    return normalizePosts(json, platform, '');
  }

  /**
   * Haalt de uitgesproken tekst op. Dit is wat een vondst van "mooie caption"
   * naar echt bruikbaar tilt: je ziet welk moment iemand koos en hoe de eerste
   * seconden klinken.
   */
  async fetchTranscript(postUrl: string, platform: Platform): Promise<string | null> {
    if (platform !== 'tiktok') return null;

    const url = new URL('https://api.scrapecreators.com/v1/tiktok/video/transcript');
    url.searchParams.set('url', postUrl);

    const res = await fetch(url, { headers: { 'x-api-key': requireEnv('SCRAPECREATORS_API_KEY') } });
    if (!res.ok) return null;

    const json = (await res.json()) as { transcript?: string };
    return json.transcript?.trim() || null;
  }

  async fetchTrending(platform: Platform, limit = 30): Promise<AccountPost[]> {
    if (platform === 'shorts') {
      const { fetchYoutubeTrendingShorts } = await import('./youtube-discovery');
      return fetchYoutubeTrendingShorts(limit);
    }
    const endpoint: Record<Exclude<Platform, 'shorts'>, string> = {
      tiktok: 'https://api.scrapecreators.com/v1/tiktok/get-trending-feed',
      reels: 'https://api.scrapecreators.com/v1/instagram/reels/trending',
    };
    const url = new URL(endpoint[platform]);
    url.searchParams.set('amount', String(limit));

    const res = await fetch(url, { headers: { 'x-api-key': requireEnv('SCRAPECREATORS_API_KEY') } });
    if (!res.ok) throw new Error(`ScrapeCreators ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as Record<string, unknown>;
    return normalizePosts(json, platform, '');
  }
}

class ApifyProvider implements MetricsProvider {
  readonly name = 'apify';
  readonly costPerCallEur = 0.005;

  async fetchPostMetrics(postUrl: string, platform: Platform): Promise<PostMetrics> {
    const actor: Record<Platform, string> = {
      tiktok: 'clockworks~tiktok-scraper',
      reels: 'apify~instagram-scraper',
      shorts: 'streamers~youtube-scraper',
    };

    const res = await fetch(
      `https://api.apify.com/v2/acts/${actor[platform]}/run-sync-get-dataset-items?token=${requireEnv('APIFY_TOKEN')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startUrls: [{ url: postUrl }], resultsLimit: 1 }),
      },
    );
    if (!res.ok) throw new Error(`Apify ${res.status}: ${await res.text()}`);

    const items = (await res.json()) as Record<string, unknown>[];
    const raw = items[0] ?? {};
    return { ...normalizeMetrics(raw), raw };
  }

  async fetchAccountPosts(handle: string, platform: Platform, limit = 30): Promise<AccountPost[]> {
    const actor: Record<Platform, string> = {
      tiktok: 'clockworks~tiktok-scraper',
      reels: 'apify~instagram-scraper',
      shorts: 'streamers~youtube-scraper',
    };
    const clean = handle.replace(/^@/, '');
    const input: Record<string, unknown> =
      platform === 'tiktok'
        ? { profiles: [clean], resultsPerPage: limit }
        : { username: [clean], resultsLimit: limit };

    const res = await fetch(
      `https://api.apify.com/v2/acts/${actor[platform]}/run-sync-get-dataset-items?token=${requireEnv('APIFY_TOKEN')}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
    );
    if (!res.ok) throw new Error(`Apify ${res.status}: ${await res.text()}`);

    const items = (await res.json()) as Record<string, unknown>[];
    return items.map((item) => toAccountPost(item, platform, handle));
  }

  async searchPosts(query: string, platform: Platform, limit = 30): Promise<AccountPost[]> {
    const actor: Record<Platform, string> = {
      tiktok: 'clockworks~tiktok-scraper',
      reels: 'apify~instagram-scraper',
      shorts: 'streamers~youtube-scraper',
    };
    const input: Record<string, unknown> =
      platform === 'tiktok'
        ? { searchQueries: [query], resultsPerPage: limit }
        : { search: query, resultsLimit: limit };

    const res = await fetch(
      `https://api.apify.com/v2/acts/${actor[platform]}/run-sync-get-dataset-items?token=${requireEnv('APIFY_TOKEN')}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
    );
    if (!res.ok) throw new Error(`Apify ${res.status}: ${await res.text()}`);

    const items = (await res.json()) as Record<string, unknown>[];
    return items.map((item) => toAccountPost(item, platform, ''));
  }

  async fetchTrending(platform: Platform, limit = 30): Promise<AccountPost[]> {
    if (platform === 'shorts') {
      const { fetchYoutubeTrendingShorts } = await import('./youtube-discovery');
      return fetchYoutubeTrendingShorts(limit);
    }
    throw new Error(`Trending op ${platform} is niet beschikbaar via Apify; gebruik ScrapeCreators.`);
  }
}

/** Providers leveren een lijst onder wisselende sleutels; we pakken de eerste array die we vinden. */
function normalizePosts(json: Record<string, unknown>, platform: Platform, handle: string): AccountPost[] {
  const list =
    (['aweme_list', 'search_item_list', 'reels', 'videos', 'posts', 'items', 'data'] as const)
      .map((key) => json[key])
      .find((value): value is Record<string, unknown>[] => Array.isArray(value)) ?? [];

  return list
    // TikTok-zoekresultaten verpakken de post nog een laag dieper.
    .map((item) => (item.aweme_info as Record<string, unknown> | undefined) ?? item)
    .map((item) => toAccountPost(item, platform, handle));
}

function toAccountPost(item: Record<string, unknown>, platform: Platform, handle: string): AccountPost {
  const metrics = normalizeMetrics(item);
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = item[key];
      if (typeof value === 'string' && value) return value;
    }
    return null;
  };

  const author = item.author as Record<string, unknown> | string | undefined;
  const user = item.user as Record<string, unknown> | undefined;
  const authorHandle =
    typeof author === 'string'
      ? author
      : ((author?.unique_id ?? author?.uniqueId ?? author?.username ?? author?.nickname) as string | undefined) ??
        ((user?.username ?? user?.full_name) as string | undefined);

  const id = pick('aweme_id', 'id', 'videoId', 'shortcode', 'code');
  const url =
    pick('url', 'webVideoUrl', 'postUrl', 'link', 'share_url') ??
    (id ? buildPostUrl(platform, authorHandle ?? handle, id) : '');

  // Tijdstippen komen in drie smaken binnen: ISO-string, unix-seconden onder
  // create_time (TikTok) of createTime (Apify).
  const timestamp = pick('createTimeISO', 'timestamp', 'publishedAt', 'taken_at', 'taken_at_date');
  const epochVeld = (item.create_time ?? item.createTime) as unknown;
  const epoch =
    typeof epochVeld === 'number' && epochVeld > 0 ? new Date(epochVeld * 1000).toISOString() : null;

  return {
    post_url: url,
    posted_at: timestamp ?? epoch,
    views: metrics.views,
    likes: metrics.likes,
    comments: metrics.comments,
    caption: pick('desc', 'text', 'caption', 'title', 'description'),
    handle: authorHandle ?? pick('uniqueId', 'username', 'channel', 'channelName', 'ownerUsername') ?? (handle || null),
    raw: item,
  };
}

function buildPostUrl(platform: Platform, handle: string, id: string): string {
  const clean = handle.replace(/^@/, '');
  if (platform === 'tiktok') return `https://www.tiktok.com/@${clean}/video/${id}`;
  if (platform === 'reels') return `https://www.instagram.com/reel/${id}/`;
  return `https://www.youtube.com/shorts/${id}`;
}

/**
 * Providers gebruiken verschillende veldnamen voor dezelfde metriek; we pakken
 * de eerste die een getal oplevert in plaats van per provider te mappen.
 */
function normalizeMetrics(raw: Record<string, unknown>): Omit<PostMetrics, 'raw'> {
  const source = (raw.aweme_detail ?? raw.data ?? raw.statistics ?? raw) as Record<string, unknown>;
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = source[key] ?? raw[key];
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    }
    return null;
  };

  return {
    views: pick('play_count', 'ig_play_count', 'playCount', 'viewCount', 'video_view_count', 'views'),
    likes: pick('digg_count', 'like_count', 'diggCount', 'likeCount', 'likesCount', 'likes'),
    comments: pick('comment_count', 'commentCount', 'commentsCount', 'comments'),
    shares: pick('share_count', 'shareCount', 'sharesCount', 'shares'),
  };
}

/**
 * Gratis backend via yt-dlp met browsercookies. Dekt TikTok en Shorts; voor
 * Reels bestaat geen gratis route (de Instagram-extractor is upstream kapot),
 * dus daar geeft hij een duidelijke fout die naar de scraping-key wijst.
 *
 * Werkt alleen waar yt-dlp en browsercookies zijn — op je eigen machine dus,
 * niet op Vercel serverless.
 */
class YtdlpFreeProvider implements MetricsProvider {
  readonly name = 'ytdlp';
  readonly costPerCallEur = 0;

  async fetchPostMetrics(postUrl: string, platform: Platform): Promise<PostMetrics> {
    const { fetchVideoMetricsViaYtdlp, ytdlpSupports } = await import('./ytdlp-social');
    if (!ytdlpSupports(platform)) throw this.reelsError();
    return fetchVideoMetricsViaYtdlp(postUrl);
  }

  async fetchAccountPosts(handle: string, platform: Platform, limit = 30): Promise<AccountPost[]> {
    const { fetchTiktokAccountPosts, fetchYoutubeChannelShorts } = await import('./ytdlp-social');
    if (platform === 'tiktok') return fetchTiktokAccountPosts(handle, limit);
    if (platform === 'shorts') return fetchYoutubeChannelShorts(handle, limit);
    throw this.reelsError();
  }

  async searchPosts(query: string, platform: Platform, limit = 12): Promise<AccountPost[]> {
    if (platform === 'shorts') {
      const { searchYoutubeShorts } = await import('./youtube-discovery');
      return searchYoutubeShorts(query, limit);
    }
    throw new Error(
      `Zoeken op ${platform} kan niet gratis via yt-dlp. Zet SCRAPECREATORS_API_KEY in .env; Shorts-zoektermen werken wel zonder key.`,
    );
  }

  async fetchTrending(platform: Platform, limit = 30): Promise<AccountPost[]> {
    if (platform === 'shorts') {
      const { fetchYoutubeTrendingShorts } = await import('./youtube-discovery');
      return fetchYoutubeTrendingShorts(limit);
    }
    throw new Error(
      `Trending op ${platform} kan niet gratis via yt-dlp. Zet SCRAPECREATORS_API_KEY in .env; Shorts-trending werkt wel zonder key.`,
    );
  }

  private reelsError(): Error {
    return new Error(
      'Instagram/Reels kan niet gratis via yt-dlp (extractor is upstream kapot). Zet SCRAPECREATORS_API_KEY in .env.',
    );
  }
}

export function getMetricsProvider(): MetricsProvider {
  if (optionalEnv('SCRAPING_PROVIDER', 'scrapecreators') === 'apify' && optionalEnv('APIFY_TOKEN')) {
    return new ApifyProvider();
  }
  if (optionalEnv('SCRAPECREATORS_API_KEY')) return new ScrapeCreatorsProvider();
  // Zonder key: de gratis route. TikTok en Shorts werken meteen; Reels legt in
  // zijn foutmelding uit wat er nodig is.
  return new YtdlpFreeProvider();
}

export function getFallbackProvider(primary: MetricsProvider): MetricsProvider | null {
  if (primary.name === 'scrapecreators' && optionalEnv('APIFY_TOKEN')) return new ApifyProvider();
  if (primary.name === 'apify' && optionalEnv('SCRAPECREATORS_API_KEY')) return new ScrapeCreatorsProvider();
  // Betaalde provider stuk? Dan is gratis alsnog beter dan niets.
  if (primary.name !== 'ytdlp') return new YtdlpFreeProvider();
  return null;
}
