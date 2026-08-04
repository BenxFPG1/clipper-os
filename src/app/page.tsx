import Link from 'next/link';
import { db, one } from '@/lib/supabase';
import { laadWerkStatus, type StapStatus } from '@/lib/status';
import { datumTijd } from '@/lib/format';
import { NuBezig } from './nu-bezig';

export const dynamic = 'force-dynamic';

type CampaignSummary = {
  id: string;
  name: string;
  cpm_eur: number;
  status: string;
  platform_rules: { max_eur_per_clip?: number } | null;
  created_at: string;
};

async function loadDashboard() {
  const supabase = db();

  const [campaigns, clips, topClip, videoTellingen, briefTellingen] = await Promise.all([
    supabase.from('campaigns').select('id, name, cpm_eur, status, platform_rules, created_at').eq('status', 'active'),
    supabase.from('clips').select('id, status, titel_intern, clip_performance(views_7d, outlier_score)'),
    supabase
      .from('clip_performance')
      .select('clip_id, views_7d, outlier_score, clips(titel_intern)')
      .order('outlier_score', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('videos').select('campaign_id').is('archived_at', null),
    supabase.from('briefs').select('campaign_id'),
  ]);

  const perCampagne = (rijen: { campaign_id: string | null }[] | null) => {
    const map = new Map<string, number>();
    for (const r of rijen ?? []) {
      if (r.campaign_id) map.set(r.campaign_id, (map.get(r.campaign_id) ?? 0) + 1);
    }
    return map;
  };
  const videosPer = perCampagne(videoTellingen.data);
  const briefsPer = perCampagne(briefTellingen.data);

  const perStatus = { planned: 0, edited: 0, posted: 0, rejected: 0 } as Record<string, number>;
  let totalViews = 0;
  for (const clip of clips.data ?? []) {
    perStatus[clip.status as string] = (perStatus[clip.status as string] ?? 0) + 1;
    const perf = one<{ views_7d: number | null }>(clip.clip_performance);
    totalViews += perf?.views_7d ?? 0;
  }

  // Omzet berekenen we bewust niet: dat staat al op het dashboard van ClipArmy.
  const campaignList = (campaigns.data ?? []) as CampaignSummary[];

  return { campaigns: campaignList, perStatus, totalViews, topClip: topClip.data, videosPer, briefsPer };
}

import { ImportCampaignForm } from './import-campaign-form';
import { ClipArmyBookmarklet } from './cliparmy-bookmarklet';

export default async function DashboardPage() {
  const [{ campaigns, perStatus, totalViews, topClip, videosPer, briefsPer }, werk] = await Promise.all([
    loadDashboard(),
    laadWerkStatus(),
  ]);
  const perCampagneStatus = new Map(werk.perCampagne.map((c) => [c.id, c]));

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Views (7d)" value={totalViews.toLocaleString('nl-NL')} />
        <Stat label="Gepost" value={String(perStatus.posted ?? 0)} />
        <Stat label="Nog te editen" value={String((perStatus.planned ?? 0) + (perStatus.edited ?? 0))} />
      </div>

      <section>
        <h2 className="mb-3 text-lg font-medium">Waar staat het werk</h2>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stap label="Plannen" hint="video's zonder clip-plan" stap={werk.stappen.plannen} />
          <Stap label="Scripts" hint="opdrachten zonder verhaallijn" stap={werk.stappen.scripts} />
          <Stap label="Monteren" hint="clips nog te knippen" stap={werk.stappen.montages} />
          <Stap label="Posten" hint="geknipt, nog niet online" stap={werk.stappen.posten} />
          <Stap label="Meten" hint="online, nog geen cijfers" stap={werk.stappen.meten} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Nu bezig</h2>
        <NuBezig taken={werk.lopend} />
      </section>

      <section className="rounded border border-neutral-800 p-4">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500">Claude-verbruik vandaag</h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span>
            <span className="font-semibold">{werk.verbruik.zwareCallsVandaag}</span>{' '}
            <span className="text-neutral-400">zware calls (plannen/scripts/concepten)</span>
          </span>
          <span>
            <span className="font-semibold">
              {werk.verbruik.opdrachtenVandaag}/{werk.verbruik.dagGrens}
            </span>{' '}
            <span className="text-neutral-400">van de dagelijkse cloudgrens</span>
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-neutral-800">
          <div
            className={`h-full ${
              werk.verbruik.opdrachtenVandaag / werk.verbruik.dagGrens > 0.8 ? 'bg-amber-500' : 'bg-neutral-500'
            }`}
            style={{
              width: `${Math.min(100, Math.round((werk.verbruik.opdrachtenVandaag / werk.verbruik.dagGrens) * 100))}%`,
            }}
          />
        </div>
        {werk.verbruik.laatsteLimiet && (
          <p className="mt-2 text-xs text-amber-300/80">
            Laatste keer limiet geraakt: {datumTijd(werk.verbruik.laatsteLimiet.wanneer)} —{' '}
            {werk.verbruik.laatsteLimiet.melding}
          </p>
        )}
        <p className="mt-1 text-xs text-neutral-500">
          De 5-uurs- en weeklimiet zelf zijn niet uitleesbaar; dit is wat de tool ervan verbruikt. Grens
          aanpassen: AI_JOBS_PER_DAG.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Actieve campagnes</h2>
        <div className="mb-3 space-y-2">
          <ImportCampaignForm />
          <ClipArmyBookmarklet />
        </div>
        {campaigns.length === 0 ? (
          <Empty>Nog geen actieve campagne. Draai `npm run seed` om de voorbeeldcampagne te laden.</Empty>
        ) : (
          <ul className="space-y-2">
            {campaigns.map((c) => (
              <li key={c.id} className="rounded border border-neutral-800 transition-colors hover:border-neutral-600">
                <Link href={`/campagnes/${c.id}`} className="flex items-center justify-between px-4 py-3">
                  <span>
                    <span className="font-medium">{c.name}</span>
                    <span className="mt-0.5 block text-sm text-neutral-400">
                      {videosPer.get(c.id) ?? 0} video&apos;s · {briefsPer.get(c.id) ?? 0} opdrachten
                    </span>
                    <span className="mt-1 block text-xs">
                      {(() => {
                        const st = perCampagneStatus.get(c.id);
                        if (!st) return null;
                        const teDoen: string[] = [];
                        if (st.videosZonderPlan > 0) teDoen.push(`${st.videosZonderPlan}× plan maken`);
                        if (st.opdrachtenZonderScript > 0)
                          teDoen.push(`${st.opdrachtenZonderScript}× script schrijven`);
                        return teDoen.length > 0 ? (
                          <span className="text-amber-300/80">Te doen: {teDoen.join(' · ')}</span>
                        ) : (
                          <span className="text-emerald-300/80">Alles verwerkt</span>
                        );
                      })()}
                    </span>
                  </span>
                  <span className="text-sm text-neutral-400">CPM €{Number(c.cpm_eur).toFixed(2)} →</span>
                </Link>
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

/** Eén stap in de keten: hoeveel er nog open staat, en waar je het doet. */
function Stap({ label, hint, stap }: { label: string; hint: string; stap: StapStatus }) {
  const klaar = stap.open === 0;
  return (
    <Link
      href={stap.href}
      className={`rounded border px-4 py-3 transition-colors ${
        klaar ? 'border-neutral-800 hover:border-neutral-600' : 'border-amber-900/60 hover:border-amber-700'
      }`}
    >
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${klaar ? 'text-neutral-500' : 'text-amber-300'}`}>
        {klaar ? '✓' : stap.open}
      </div>
      <div className="text-xs text-neutral-500">
        {klaar ? 'niets open' : hint} · {stap.af} af
      </div>
    </Link>
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
