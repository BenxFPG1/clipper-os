import Link from 'next/link';
import { db, one } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type CampaignSummary = {
  id: string;
  name: string;
  cpm_eur: number;
  status: string;
  platform_rules: { max_eur_per_clip?: number } | null;
};

async function loadDashboard() {
  const supabase = db();

  const [campaigns, clips, topClip] = await Promise.all([
    supabase.from('campaigns').select('id, name, cpm_eur, status, platform_rules').eq('status', 'active'),
    supabase.from('clips').select('id, status, titel_intern, clip_performance(views_7d, outlier_score)'),
    supabase
      .from('clip_performance')
      .select('clip_id, views_7d, outlier_score, clips(titel_intern)')
      .order('outlier_score', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const perStatus = { planned: 0, edited: 0, posted: 0, rejected: 0 } as Record<string, number>;
  let totalViews = 0;
  for (const clip of clips.data ?? []) {
    perStatus[clip.status as string] = (perStatus[clip.status as string] ?? 0) + 1;
    const perf = one<{ views_7d: number | null }>(clip.clip_performance);
    totalViews += perf?.views_7d ?? 0;
  }

  const campaignList = (campaigns.data ?? []) as CampaignSummary[];
  const cpm = campaignList[0]?.cpm_eur ?? 0.5;
  const maxPerClip = campaignList[0]?.platform_rules?.max_eur_per_clip ?? Infinity;

  // Verdiensten-schatting: views x CPM, per clip gecapt op het campagnemaximum.
  const earnings = (clips.data ?? []).reduce((sum, clip) => {
    const views = one<{ views_7d: number | null }>(clip.clip_performance)?.views_7d ?? 0;
    return sum + Math.min((views / 1000) * cpm, maxPerClip);
  }, 0);

  return { campaigns: campaignList, perStatus, totalViews, earnings, topClip: topClip.data };
}

import { ImportCampaignForm } from './import-campaign-form';

export default async function DashboardPage() {
  const { campaigns, perStatus, totalViews, earnings, topClip } = await loadDashboard();

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Views (7d)" value={totalViews.toLocaleString('nl-NL')} />
        <Stat label="Geschatte omzet" value={`€${earnings.toFixed(2)}`} />
        <Stat label="Gepost" value={String(perStatus.posted ?? 0)} />
        <Stat label="Nog te editen" value={String((perStatus.planned ?? 0) + (perStatus.edited ?? 0))} />
      </div>

      <section>
        <h2 className="mb-3 text-lg font-medium">Actieve campagnes</h2>
        <div className="mb-3">
          <ImportCampaignForm />
        </div>
        {campaigns.length === 0 ? (
          <Empty>Nog geen actieve campagne. Draai `npm run seed` om de voorbeeldcampagne te laden.</Empty>
        ) : (
          <ul className="space-y-2">
            {campaigns.map((c) => (
              <li key={c.id} className="rounded border border-neutral-800 px-4 py-3">
                <div className="flex items-center justify-between">
                  <span>{c.name}</span>
                  <span className="text-sm text-neutral-400">CPM €{Number(c.cpm_eur).toFixed(2)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Beste clip</h2>
        {topClip ? (
          <div className="rounded border border-neutral-800 px-4 py-3">
            <div>{one<{ titel_intern: string }>(topClip.clips)?.titel_intern ?? 'Onbekende clip'}</div>
            <div className="text-sm text-neutral-400">
              {(topClip.views_7d ?? 0).toLocaleString('nl-NL')} views · outlier-score{' '}
              {topClip.outlier_score ?? '—'}
            </div>
          </div>
        ) : (
          <Empty>Nog geen performance-data. Plak een post-URL bij een clip en wacht op de eerste cron-run.</Empty>
        )}
      </section>

      <Link href="/videos" className="inline-block rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900">
        Naar video&apos;s
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-800 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">{children}</p>;
}
