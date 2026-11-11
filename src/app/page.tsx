import Link from 'next/link';
import { db, one } from '@/lib/supabase';
import { laadVastgelopen, laadWerkStatus } from '@/lib/status';
import { beoordeelWachtrij } from '@/lib/tracking/leerlus';
import { NuBezig } from './nu-bezig';
import { VastgelopenBlok } from './vastgelopen-blok';

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

  const [campaigns, clips, topClip, videoTellingen, briefTellingen, plannen, renders] = await Promise.all([
    supabase.from('campaigns').select('id, name, cpm_eur, status, platform_rules, created_at').neq('status', 'ended'),
    supabase.from('clips').select('id, status, titel_intern, clip_performance(views_7d, outlier_score)'),
    supabase
      .from('clip_performance')
      .select('clip_id, views_7d, outlier_score, clips(titel_intern)')
      .order('outlier_score', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('videos').select('id, campaign_id').is('archived_at', null),
    supabase.from('briefs').select('campaign_id'),
    supabase.from('clip_plans').select('video_id'),
    supabase.from('render_jobs').select('video_id'),
  ]);

  // Video's met een plan waar nog geen enkele clip van gemaakt is: dát is wat
  // er bij "clips maken" op je wacht. (Het aantal geplande clips zelf loopt
  // in de honderden en zegt niets: je maakt er nooit alle van.)
  const actief = new Set((videoTellingen.data ?? []).map((v) => v.id as string));
  const metPlan = new Set((plannen.data ?? []).map((p) => p.video_id as string).filter((id) => actief.has(id)));
  const metRender = new Set((renders.data ?? []).map((r) => r.video_id as string));
  const zonderClips = [...metPlan].filter((id) => !metRender.has(id)).length;

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

  return { campaigns: campaignList, perStatus, totalViews, topClip: topClip.data, videosPer, briefsPer, zonderClips };
}

import { ImportCampaignForm } from './import-campaign-form';

export default async function StartPage() {
  const [{ campaigns, perStatus, totalViews, topClip, videosPer, briefsPer, zonderClips }, werk, vastgelopen, teBeoordelen] = await Promise.all([
    loadDashboard(),
    laadWerkStatus(),
    // Een fout in een bijzaak mag de startpagina niet platleggen.
    laadVastgelopen().catch(() => []),
    beoordeelWachtrij({ limiet: 0 })
      .then((r) => r.totaal)
      .catch(() => null),
  ]);
  const perCampagneStatus = new Map(werk.perCampagne.map((c) => [c.id, c]));
  const { plannen, posten, meten } = werk.stappen;

  return (
    <div className="space-y-8">
      <VastgelopenBlok items={vastgelopen} />

      <section>
        <h1 className="text-2xl font-semibold">Van video naar clip</h1>
        <p className="mt-1 text-sm text-neutral-400">Vier stappen. Het gele getal is wat er op jou wacht.</p>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stap
            nummer={1}
            titel="Video toevoegen"
            href="/videos"
            open={plannen.open}
            uitleg={plannen.open > 0 ? `${plannen.open} video${plannen.open === 1 ? '' : "'s"} zonder clip-plan` : 'Plak een YouTube-, Drive- of WeTransfer-link'}
            knop="Video toevoegen"
          />
          <Stap
            nummer={2}
            titel="Clips maken"
            href="/videos"
            open={zonderClips}
            uitleg={zonderClips > 0 ? `${zonderClips} video${zonderClips === 1 ? ' heeft' : "'s hebben"} een plan, maar nog geen clips` : 'Kies bij een video welke clips je wilt'}
            knop="Naar de video's"
          />
          <Stap
            nummer={3}
            titel="Beoordelen"
            href="/beoordelen"
            open={teBeoordelen ?? 0}
            uitleg={teBeoordelen ? `${teBeoordelen} clip${teBeoordelen === 1 ? '' : 's'} wacht${teBeoordelen === 1 ? '' : 'en'} op jouw oordeel` : 'Bekijk elke clip en zeg goed, matig of weg'}
            knop="Clips bekijken"
          />
          <Stap
            nummer={4}
            titel="Posten en meten"
            href="/performance"
            open={posten.open + meten.open}
            uitleg={
              posten.open + meten.open > 0
                ? `${posten.open} klaar om te posten, ${meten.open} zonder cijfers`
                : 'Plak de link van je post; de cijfers komen vanzelf'
            }
            knop="Resultaten"
          />
        </ol>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Nu bezig</h2>
        <NuBezig taken={werk.lopend} />
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Clips gepost" value={String(perStatus.posted ?? 0)} />
        <Stat label="Views (7 dagen)" value={totalViews.toLocaleString('nl-NL')} />
        <Stat
          label="Beste clip"
          value={topClip ? `${(topClip.views_7d ?? 0).toLocaleString('nl-NL')} views` : '—'}
          onder={topClip ? (one<{ titel_intern: string }>(topClip.clips)?.titel_intern ?? undefined) : 'nog niets gemeten'}
        />
      </div>

      <section>
        <h2 className="mb-3 text-lg font-medium">Campagnes</h2>
        <div className="mb-3">
          <ImportCampaignForm />
        </div>
        {campaigns.length === 0 ? (
          <Empty>Nog geen campagne. Importeer er een hierboven, of koppel ClipArmy bij Instellingen.</Empty>
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
    </div>
  );
}

/** Eén stap van de route: wat je er doet, hoeveel er op je wacht, en de knop erheen. */
function Stap({ nummer, titel, uitleg, href, open, knop }: { nummer: number; titel: string; uitleg: string; href: string; open: number; knop: string }) {
  return (
    <li>
      <Link
        href={href}
        className={`flex h-full flex-col rounded border px-4 py-3 transition-colors ${
          open > 0 ? 'border-amber-900/60 hover:border-amber-700' : 'border-neutral-800 hover:border-neutral-600'
        }`}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-neutral-500">Stap {nummer}</span>
          {open > 0 && <span className="rounded-full bg-amber-400 px-2 text-xs font-medium text-neutral-900">{open}</span>}
        </div>
        <div className="mt-1 text-lg font-medium">{titel}</div>
        <div className="mt-1 flex-1 text-sm text-neutral-400">{uitleg}</div>
        <div className="mt-3 text-sm text-neutral-200">{knop} →</div>
      </Link>
    </li>
  );
}

function Stat({ label, value, onder }: { label: string; value: string; onder?: string }) {
  return (
    <div className="rounded border border-neutral-800 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
      {onder && <div className="mt-0.5 truncate text-xs text-neutral-500">{onder}</div>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">{children}</p>;
}
