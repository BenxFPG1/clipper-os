import { db, one } from '@/lib/supabase';
import { PerformanceTable } from './performance-table';

export const dynamic = 'force-dynamic';

export type PerformanceRow = {
  id: string;
  titel_intern: string | null;
  structure_type: string | null;
  hook_type: string | null;
  platform: string | null;
  post_url: string | null;
  posted_at: string | null;
  views_24h: number | null;
  views_7d: number | null;
  velocity_score: number | null;
  outlier_score: number | null;
  history: { captured_at: string; views: number | null }[];
};

export default async function PerformancePage() {
  const { data } = await db()
    .from('clips')
    .select(
      'id, titel_intern, structure_type, hook_type, platform, post_url, posted_at, clip_performance(views_24h, views_7d, velocity_score, outlier_score), metrics_snapshots(captured_at, views)',
    )
    .eq('status', 'posted')
    .order('posted_at', { ascending: false });

  const rows: PerformanceRow[] = (data ?? []).map((clip) => {
    const perf = one<{
      views_24h: number | null;
      views_7d: number | null;
      velocity_score: number | null;
      outlier_score: number | null;
    }>(clip.clip_performance);
    return {
      id: clip.id as string,
      titel_intern: clip.titel_intern as string | null,
      structure_type: clip.structure_type as string | null,
      hook_type: clip.hook_type as string | null,
      platform: clip.platform as string | null,
      post_url: clip.post_url as string | null,
      posted_at: clip.posted_at as string | null,
      views_24h: perf?.views_24h ?? null,
      views_7d: perf?.views_7d ?? null,
      velocity_score: perf?.velocity_score ?? null,
      outlier_score: perf?.outlier_score ?? null,
      history: ((clip.metrics_snapshots ?? []) as { captured_at: string; views: number | null }[]).sort(
        (a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime(),
      ),
    };
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Performance</h1>
      {rows.length === 0 ? (
        <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
          Nog geen geposte clips met metingen.
        </p>
      ) : (
        <PerformanceTable rows={rows} />
      )}
    </div>
  );
}
