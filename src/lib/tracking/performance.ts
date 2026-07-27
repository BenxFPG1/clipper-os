import { db } from '../supabase';

export type Snapshot = { captured_at: string; views: number | null };

const HOUR = 3600 * 1000;

/**
 * Views op een bepaald aantal uur na posten, lineair geïnterpoleerd tussen de
 * twee omliggende snapshots. Geeft null als er nog geen meting ná dat punt is —
 * dan weten we het simpelweg nog niet en is doorrekenen misleidend.
 */
export function viewsAt(snapshots: Snapshot[], postedAt: string, hours: number): number | null {
  const target = new Date(postedAt).getTime() + hours * HOUR;
  const points = snapshots
    .filter((s) => s.views !== null)
    .map((s) => ({ t: new Date(s.captured_at).getTime(), v: s.views as number }))
    .sort((a, b) => a.t - b.t);

  if (points.length === 0) return null;
  if (target <= points[0].t) return points[0].v;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (target <= curr.t) {
      const span = curr.t - prev.t;
      if (span === 0) return curr.v;
      const ratio = (target - prev.t) / span;
      return Math.round(prev.v + (curr.v - prev.v) * ratio);
    }
  }

  return null; // target ligt na de laatste meting
}

export function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Herberekent clip_performance voor alle geposte clips en werkt de medianen van
 * onze eigen accounts bij. velocity_score en outlier_score zijn relatief aan die
 * medianen, zodat "goed" meegroeit met het account in plaats van een vast getal.
 */
export async function recomputePerformance(): Promise<{ updated: number }> {
  const supabase = db();

  const { data: clips, error } = await supabase
    .from('clips')
    .select('id, platform, posted_at, metrics_snapshots(captured_at, views)')
    .eq('status', 'posted')
    .not('posted_at', 'is', null);
  if (error) throw error;

  const rows = (clips ?? []).map((clip) => {
    const snapshots = (clip.metrics_snapshots ?? []) as Snapshot[];
    const postedAt = clip.posted_at as string;
    return {
      clip_id: clip.id as string,
      platform: clip.platform as string | null,
      views_6h: viewsAt(snapshots, postedAt, 6),
      views_24h: viewsAt(snapshots, postedAt, 24),
      views_48h: viewsAt(snapshots, postedAt, 48),
      views_7d: viewsAt(snapshots, postedAt, 24 * 7),
    };
  });

  // Medianen per platform over onze eigen clips.
  const medians = new Map<string, { m24: number | null; m7d: number | null }>();
  for (const platform of new Set(rows.map((r) => r.platform).filter(Boolean) as string[])) {
    const scoped = rows.filter((r) => r.platform === platform);
    medians.set(platform, {
      m24: median(scoped.map((r) => r.views_24h).filter((v): v is number => v !== null)),
      m7d: median(scoped.map((r) => r.views_7d).filter((v): v is number => v !== null)),
    });
  }

  const performanceRows = rows.map((r) => {
    const m = r.platform ? medians.get(r.platform) : undefined;
    return {
      clip_id: r.clip_id,
      views_6h: r.views_6h,
      views_24h: r.views_24h,
      views_48h: r.views_48h,
      views_7d: r.views_7d,
      velocity_score: m?.m24 && r.views_24h !== null ? round2(r.views_24h / m.m24) : null,
      outlier_score: m?.m7d && r.views_7d !== null ? round2(r.views_7d / m.m7d) : null,
      updated_at: new Date().toISOString(),
    };
  });

  if (performanceRows.length > 0) {
    const { error: upsertError } = await supabase
      .from('clip_performance')
      .upsert(performanceRows, { onConflict: 'clip_id' });
    if (upsertError) throw upsertError;
  }

  for (const [platform, m] of medians) {
    await supabase.from('tracked_accounts').upsert(
      {
        handle: 'ons_account',
        platform,
        our_own: true,
        median_views_24h: m.m24 !== null ? Math.round(m.m24) : null,
        median_views_7d: m.m7d !== null ? Math.round(m.m7d) : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'handle,platform' },
    );
  }

  return { updated: performanceRows.length };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
