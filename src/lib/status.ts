import { db } from './supabase';

export type StapStatus = {
  /** Wat er in deze stap nog te doen is. */
  open: number;
  /** Wat er al af is. */
  af: number;
  /** Waar je heen gaat om deze stap te doen. */
  href: string;
};

export type LopendeTaak = {
  soort: string;
  wat: string;
  status: string;
  sinds: string | null;
};

export type WerkStatus = {
  stappen: {
    plannen: StapStatus;
    scripts: StapStatus;
    montages: StapStatus;
    posten: StapStatus;
    meten: StapStatus;
  };
  lopend: LopendeTaak[];
  perCampagne: {
    id: string;
    naam: string;
    videosZonderPlan: number;
    opdrachtenZonderScript: number;
    scriptsKlaar: number;
  }[];
};

/**
 * De stand van het werk in één blik: per stap in de keten hoeveel er nog open
 * staat, wat er op dit moment in de cloud draait, en waar je heen moet om het
 * op te pakken. Bedoeld om te zien waar het stokt zonder overal te klikken.
 */
export async function laadWerkStatus(): Promise<WerkStatus> {
  const supabase = db();

  const [campagnes, videos, plannen, briefs, scripts, clips, aiJobs, renderJobs] = await Promise.all([
    supabase.from('campaigns').select('id, name').eq('status', 'active'),
    supabase.from('videos').select('id, title, campaign_id').is('archived_at', null),
    supabase.from('clip_plans').select('video_id'),
    supabase.from('briefs').select('id, titel, campaign_id'),
    supabase.from('brief_scripts').select('id, brief_id'),
    supabase.from('clips').select('id, status, post_url, clip_performance(views_7d)'),
    supabase.from('ai_jobs').select('soort, doel_id, status, created_at').in('status', ['wachtend', 'bezig']),
    supabase.from('render_jobs').select('titel, status, created_at').in('status', ['wachtend', 'bezig']),
  ]);

  const videoLijst = videos.data ?? [];
  const videosMetPlan = new Set((plannen.data ?? []).map((p) => p.video_id as string));
  const briefLijst = briefs.data ?? [];
  const briefsMetScript = new Set((scripts.data ?? []).map((s) => s.brief_id as string));
  const clipLijst = clips.data ?? [];

  const gepost = clipLijst.filter((c) => c.post_url);
  const gemeten = gepost.filter((c) => {
    const perf = c.clip_performance as { views_7d: number | null }[] | { views_7d: number | null } | null;
    if (!perf) return false;
    return Array.isArray(perf) ? perf.length > 0 : true;
  });

  const lopend: LopendeTaak[] = [
    ...(aiJobs.data ?? []).map((j) => ({
      soort:
        j.soort === 'clip_plan' ? 'Clip-plan' : j.soort === 'scripts' ? 'Verhaallijnen' : 'Concepten',
      wat: naamVoor(j.soort as string, j.doel_id as string, videoLijst, briefLijst, campagnes.data ?? []),
      status: j.status as string,
      sinds: (j.created_at as string) ?? null,
    })),
    ...(renderJobs.data ?? []).map((r) => ({
      soort: 'Montage',
      wat: (r.titel as string) ?? 'alle clips uit het plan',
      status: r.status as string,
      sinds: (r.created_at as string) ?? null,
    })),
  ];

  return {
    stappen: {
      plannen: {
        open: videoLijst.filter((v) => !videosMetPlan.has(v.id as string)).length,
        af: videoLijst.filter((v) => videosMetPlan.has(v.id as string)).length,
        href: '/videos',
      },
      scripts: {
        open: briefLijst.filter((b) => !briefsMetScript.has(b.id as string)).length,
        af: briefLijst.filter((b) => briefsMetScript.has(b.id as string)).length,
        href: '/opdrachten',
      },
      montages: {
        open: clipLijst.filter((c) => c.status === 'planned').length,
        af: clipLijst.filter((c) => c.status === 'edited' || c.status === 'posted').length,
        href: '/videos',
      },
      posten: {
        open: clipLijst.filter((c) => c.status === 'edited' && !c.post_url).length,
        af: gepost.length,
        href: '/performance',
      },
      meten: {
        open: gepost.length - gemeten.length,
        af: gemeten.length,
        href: '/performance',
      },
    },
    lopend,
    perCampagne: (campagnes.data ?? []).map((c) => {
      const eigenVideos = videoLijst.filter((v) => v.campaign_id === c.id);
      const eigenBriefs = briefLijst.filter((b) => b.campaign_id === c.id);
      return {
        id: c.id as string,
        naam: c.name as string,
        videosZonderPlan: eigenVideos.filter((v) => !videosMetPlan.has(v.id as string)).length,
        opdrachtenZonderScript: eigenBriefs.filter((b) => !briefsMetScript.has(b.id as string)).length,
        scriptsKlaar: eigenBriefs.filter((b) => briefsMetScript.has(b.id as string)).length,
      };
    }),
  };
}

function naamVoor(
  soort: string,
  doelId: string,
  videos: { id: string; title: string }[],
  briefs: { id: string; titel: string }[],
  campagnes: { id: string; name: string }[],
): string {
  if (soort === 'clip_plan') return videos.find((v) => v.id === doelId)?.title ?? 'video';
  if (soort === 'scripts') return briefs.find((b) => b.id === doelId)?.titel ?? 'opdracht';
  return campagnes.find((c) => c.id === doelId)?.name ?? 'campagne';
}
