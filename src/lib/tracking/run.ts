import { COST_ALERT_EUR } from '../env';
import { db, logProviderUsage } from '../supabase';
import { Platform, detectPlatform, getFallbackProvider, getMetricsProvider } from './provider';
import { recomputePerformance } from './performance';

const MAX_ATTEMPTS = 3;
const TRACKING_WINDOW_DAYS = 30;

export type TrackingResult = {
  attempted: number;
  succeeded: number;
  failed: { clipId: string; error: string }[];
  costEur: number;
  performanceUpdated: number;
  costAlert: string | null;
};

/**
 * Haalt voor elke geposte clip binnen het 30-daagse venster een nieuwe meting op.
 * Eén clip die faalt laat de run nooit crashen: na drie pogingen (met backoff en
 * eventueel de fallback-provider) noteren we de fout en gaan we door.
 */
export async function runTracking(): Promise<TrackingResult> {
  const supabase = db();
  const primary = getMetricsProvider();
  const fallback = getFallbackProvider(primary);

  const cutoff = new Date(Date.now() - TRACKING_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: clips, error } = await supabase
    .from('clips')
    .select('id, post_url, platform, posted_at')
    .eq('status', 'posted')
    .not('post_url', 'is', null)
    .gte('posted_at', cutoff);
  if (error) throw error;

  const result: TrackingResult = {
    attempted: clips?.length ?? 0,
    succeeded: 0,
    failed: [],
    costEur: 0,
    performanceUpdated: 0,
    costAlert: null,
  };

  for (const clip of clips ?? []) {
    const platform = (clip.platform as Platform | null) ?? detectPlatform(clip.post_url as string);
    if (!platform) {
      result.failed.push({ clipId: clip.id, error: 'Platform niet te bepalen uit post_url' });
      continue;
    }

    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const provider = attempt === MAX_ATTEMPTS && fallback ? fallback : primary;
      try {
        const metrics = await provider.fetchPostMetrics(clip.post_url as string, platform);
        result.costEur += provider.costPerCallEur;

        await supabase.from('metrics_snapshots').insert({
          clip_id: clip.id,
          views: metrics.views,
          likes: metrics.likes,
          comments: metrics.comments,
          shares: metrics.shares,
          raw: metrics.raw,
        });
        await logProviderUsage(provider.name, 'fetch_post_metrics', 1, provider.costPerCallEur);

        if (!clip.platform) await supabase.from('clips').update({ platform }).eq('id', clip.id);

        result.succeeded++;
        lastError = '';
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < MAX_ATTEMPTS) await sleep(500 * 2 ** attempt);
      }
    }

    if (lastError) result.failed.push({ clipId: clip.id, error: lastError });
  }

  result.performanceUpdated = (await recomputePerformance()).updated;
  result.costAlert = await checkMonthlyCost();
  return result;
}

/**
 * Kostenbewaking uit sectie 9: alert zodra de providerkosten deze maand het
 * plafond raken. `claude-code` telt bewust niet mee: dat is een
 * schaduwberekening van wat een call zou hebben gekost via losse
 * API-credits, geen echte rekening — met CLAUDE_BACKEND=claude-code loopt
 * alles via het vaste abonnement. Meetellen gaf hier een vals alarm (>€80
 * "kosten" terwijl er in werkelijkheid voor een paar euro aan
 * ScrapeCreators/Groq/Apify was verbruikt).
 */
async function checkMonthlyCost(): Promise<string | null> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const { data, error } = await db()
    .from('provider_usage')
    .select('provider, cost_eur')
    .gte('created_at', monthStart.toISOString());
  if (error) return null;

  const total = (data ?? [])
    .filter((row) => row.provider !== 'claude-code')
    .reduce((sum, row) => sum + Number(row.cost_eur ?? 0), 0);
  if (total <= COST_ALERT_EUR) return null;
  return `Echte providerkosten deze maand (excl. Claude-abonnement): €${total.toFixed(2)} (plafond €${COST_ALERT_EUR}).`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
