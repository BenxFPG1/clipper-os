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
}

export function detectPlatform(postUrl: string): Platform | null {
  if (/tiktok\.com/i.test(postUrl)) return 'tiktok';
  if (/instagram\.com/i.test(postUrl)) return 'reels';
  if (/youtube\.com|youtu\.be/i.test(postUrl)) return 'shorts';
  return null;
}

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
      tiktok: 'https://api.scrapecreators.com/v1/tiktok/profile/videos',
      reels: 'https://api.scrapecreators.com/v1/instagram/user/posts',
      shorts: 'https://api.scrapecreators.com/v1/youtube/channel/videos',
    };

    const url = new URL(endpoint[platform]);
    url.searchParams.set('handle', handle.replace(/^@/, ''));
    url.searchParams.set('amount', String(limit));

    const res = await fetch(url, { headers: { 'x-api-key': requireEnv('SCRAPECREATORS_API_KEY') } });
    if (!res.ok) throw new Error(`ScrapeCreators ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as Record<string, unknown>;
    return normalizePosts(json, platform, handle);
  }

  async searchPosts(query: string, platform: Platform, limit = 30): Promise<AccountPost[]> {
    const endpoint: Record<Platform, string> = {
      tiktok: 'https://api.scrapecreators.com/v1/tiktok/search/keyword',
      reels: 'https://api.scrapecreators.com/v1/instagram/search/reels',
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
}

/** Providers leveren een lijst onder wisselende sleutels; we pakken de eerste array die we vinden. */
function normalizePosts(json: Record<string, unknown>, platform: Platform, handle: string): AccountPost[] {
  const list =
    (['videos', 'posts', 'items', 'data', 'aweme_list'] as const)
      .map((key) => json[key])
      .find((value): value is Record<string, unknown>[] => Array.isArray(value)) ?? [];
  return list.map((item) => toAccountPost(item, platform, handle));
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

  const id = pick('id', 'aweme_id', 'videoId', 'shortcode', 'code');
  const url =
    pick('url', 'webVideoUrl', 'postUrl', 'link', 'share_url') ??
    (id ? buildPostUrl(platform, handle, id) : '');

  const timestamp = pick('createTimeISO', 'timestamp', 'publishedAt', 'taken_at_date');
  const epoch = typeof item.createTime === 'number' ? new Date(item.createTime * 1000).toISOString() : null;

  const author = item.author as Record<string, unknown> | string | undefined;
  const authorHandle =
    typeof author === 'string'
      ? author
      : ((author?.uniqueId ?? author?.username ?? author?.name) as string | undefined);

  return {
    post_url: url,
    posted_at: timestamp ?? epoch,
    views: metrics.views,
    likes: metrics.likes,
    comments: metrics.comments,
    caption: pick('text', 'caption', 'title', 'description'),
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
    views: pick('play_count', 'playCount', 'viewCount', 'video_view_count', 'views'),
    likes: pick('digg_count', 'diggCount', 'likeCount', 'likesCount', 'likes'),
    comments: pick('comment_count', 'commentCount', 'commentsCount', 'comments'),
    shares: pick('share_count', 'shareCount', 'sharesCount', 'shares'),
  };
}

export function getMetricsProvider(): MetricsProvider {
  return optionalEnv('SCRAPING_PROVIDER', 'scrapecreators') === 'apify'
    ? new ApifyProvider()
    : new ScrapeCreatorsProvider();
}

export function getFallbackProvider(primary: MetricsProvider): MetricsProvider | null {
  if (primary.name === 'scrapecreators' && optionalEnv('APIFY_TOKEN')) return new ApifyProvider();
  if (primary.name === 'apify' && optionalEnv('SCRAPECREATORS_API_KEY')) return new ScrapeCreatorsProvider();
  return null;
}
