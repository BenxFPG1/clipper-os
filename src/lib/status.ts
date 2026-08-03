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
  /** Seconden dat deze opdracht al bezig is (null als hij nog wacht). */
  bezigSeconden: number | null;
  /** Verwachte duur op basis van eerdere opdrachten van dezelfde soort. */
  schattingSeconden: number | null;
  /** Plek in de rij voor wachtende opdrachten (1 = als eerstvolgende). */
  wachtrijPlek: number | null;
};

export type Verbruik = {
  /** Zware Opus-calls vandaag (plannen, scripts, concepten; incl. examens). */
  zwareCallsVandaag: number;
  /** Afgeronde cloudopdrachten vandaag, tegen de dagelijkse grens. */
  opdrachtenVandaag: number;
  dagGrens: number;
  /** Laatste keer dat de Claude-limiet geraakt werd, met de resettijd eruit. */
  laatsteLimiet: { wanneer: string; melding: string } | null;
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
  verbruik: Verbruik;
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
    supabase
      .from('ai_jobs')
      .select('soort, doel_id, status, created_at, gestart_at')
      .in('status', ['wachtend', 'bezig'])
      .order('created_at'),
    supabase
      .from('render_jobs')
      .select('titel, status, created_at, gestart_at, voortgang, gedaan, totaal')
      .in('status', ['wachtend', 'bezig'])
      .order('created_at'),
  ]);

  // Verwachte duur uit wat we gemeten hebben: het middelste van de laatste
  // geslaagde opdrachten per soort. Zonder metingen doen we geen uitspraak.
  const { data: afgerond } = await supabase
    .from('ai_jobs')
    .select('soort, gestart_at, klaar_at')
    .eq('status', 'klaar')
    .not('gestart_at', 'is', null)
    .order('klaar_at', { ascending: false })
    .limit(40);

  const durenPerSoort = new Map<string, number[]>();
  for (const j of afgerond ?? []) {
    const duur = (new Date(j.klaar_at as string).getTime() - new Date(j.gestart_at as string).getTime()) / 1000;
    if (duur <= 0 || duur > 4 * 3600) continue;
    const lijst = durenPerSoort.get(j.soort as string) ?? [];
    lijst.push(duur);
    durenPerSoort.set(j.soort as string, lijst);
  }
  const schatting = (soort: string): number | null => {
    const lijst = durenPerSoort.get(soort);
    if (!lijst?.length) return null;
    const gesorteerd = [...lijst].sort((a, b) => a - b);
    return Math.round(gesorteerd[Math.floor(gesorteerd.length / 2)]);
  };
  const nu = Date.now();

  // Verbruik van vandaag: hoe hard drukken we op de abonnementslimiet?
  const vandaag = new Date();
  vandaag.setUTCHours(0, 0, 0, 0);
  const ZWAAR = ['clip_plan', 'clip_plan_examen', 'character_map', 'scriptwriter', 'scriptwriter_examen', 'campagne_concepten'];
  const [zwaarRes, klaarVandaagRes, limietRes] = await Promise.all([
    supabase
      .from('provider_usage')
      .select('id', { count: 'exact', head: true })
      .in('operation', ZWAAR)
      .gte('created_at', vandaag.toISOString()),
    supabase
      .from('ai_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'klaar')
      .gte('klaar_at', vandaag.toISOString()),
    supabase
      .from('ai_jobs')
      .select('fout, klaar_at, created_at')
      .not('fout', 'is', null)
      .ilike('fout', '%limit%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
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

  let plek = 0;
  const lopend: LopendeTaak[] = [
    ...(aiJobs.data ?? []).map((j) => {
      const bezig = j.status === 'bezig' && j.gestart_at;
      if (j.status === 'wachtend') plek += 1;
      return {
        soort:
          j.soort === 'clip_plan' ? 'Clip-plan' : j.soort === 'scripts' ? 'Verhaallijnen' : 'Concepten',
        wat: naamVoor(j.soort as string, j.doel_id as string, videoLijst, briefLijst, campagnes.data ?? []),
        status: j.status as string,
        sinds: (j.created_at as string) ?? null,
        bezigSeconden: bezig ? Math.round((nu - new Date(j.gestart_at as string).getTime()) / 1000) : null,
        schattingSeconden: schatting(j.soort as string),
        wachtrijPlek: j.status === 'wachtend' ? plek : null,
      };
    }),
    ...(renderJobs.data ?? []).map((r) => ({
      soort: 'Montage',
      wat:
        r.status === 'bezig' && r.totaal
          ? `clip ${Math.min(((r.gedaan as number) ?? 0) + 1, r.totaal as number)}/${r.totaal}${
              r.voortgang ? ` — ${(r.voortgang as string).slice(0, 50)}` : ''
            }`
          : ((r.titel as string) ?? 'alle clips uit het plan'),
      status: r.status as string,
      sinds: (r.created_at as string) ?? null,
      bezigSeconden:
        r.status === 'bezig' && r.gestart_at
          ? Math.round((nu - new Date(r.gestart_at as string).getTime()) / 1000)
          : null,
      schattingSeconden: null,
      wachtrijPlek: null,
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
    verbruik: {
      zwareCallsVandaag: zwaarRes.count ?? 0,
      opdrachtenVandaag: klaarVandaagRes.count ?? 0,
      dagGrens: Number(process.env.AI_JOBS_PER_DAG ?? 20),
      laatsteLimiet: limietRes.data
        ? {
            wanneer: (limietRes.data.klaar_at as string) ?? (limietRes.data.created_at as string),
            melding: (limietRes.data.fout as string).slice(0, 120),
          }
        : null,
    },
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
