import { optionalEnv, requireEnv } from '../env';

export type PostMetrics = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  raw: unknown;
};

export type Platform = 'tiktok' | 'reels' | 'shorts';

/**
 * Eén interface voor alle scraping-providers, zodat ScrapeCreators en Apify
 * uitwisselbaar zijn (sectie 13: provider-afhankelijkheid).
 */
export interface MetricsProvider {
  readonly name: string;
  /** Geschatte credits/kosten in euro per call, voor de kostenbewaking. */
  readonly costPerCallEur: number;
  fetchPostMetrics(postUrl: string, platform: Platform): Promise<PostMetrics>;
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
