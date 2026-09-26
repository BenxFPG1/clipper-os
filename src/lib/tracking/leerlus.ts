import { optionalEnv } from '../env';
import { db, one } from '../supabase';
import { detectPlatform, type Platform } from './provider';

/**
 * De leerlus rond gerenderde bestanden: wat vond je ervan (beoordeling), is hij
 * gepost, en hoe deed hij het. Tot nu toe verdween het oordeel van wie de
 * renders bekeek in het niets en werd bijna niets gepost, dus had de retro
 * alleen externe data om van te leren. Dit bestand is de ene plek waar
 * API-routes, de smaak-agent, de retro en de eval-set dezelfde koppeling
 * gebruiken: render-bestand → clip-plan → clip-rij → metingen.
 */

export const OORDELEN = ['goed', 'matig', 'weg'] as const;
export type Oordeel = (typeof OORDELEN)[number];

/** Zoals de worker hem in render_jobs.bestanden zet (plus wat de leerlus eraan hangt). */
export type RenderBestand = {
  naam: string;
  pad: string;
  bytes: number;
  hook_variant?: number;
  hook_tekst?: string;
  keuring?: { status?: string; goed?: boolean | null; regels?: { goed: boolean | null; naam: string; detail: string }[] } | null;
  /** Meetbare montagekenmerken, gevuld door de job render_vingerafdruk. */
  vingerafdruk?: unknown;
  /** Waarom de vingerafdruk niet lukte; dan proberen we hem niet elke run opnieuw. */
  vingerafdruk_fout?: string;
};

export type RenderJobRij = {
  id: string;
  video_id: string | null;
  clip_index: number | null;
  titel: string | null;
  status: string;
  bestanden: RenderBestand[] | null;
  created_at: string;
  gestart_at: string | null;
  klaar_at: string | null;
};

/**
 * Clipnummer (1-based, zoals render_jobs.clip_index) uit de bestandsnaam. De
 * worker noemt elk bestand "02-titel.mp4"; bij een job met "alle clips" is dat
 * de enige plek waar staat welke clip het is.
 */
export function clipNummerUitNaam(naam: string, fallback: number | null = null): number | null {
  const m = /^(\d{1,3})-/.exec(naam);
  return m ? Number(m[1]) : fallback;
}

/** Hookvariant van een bestand: de hoofdversie (gekozen hook) is 1, de alternatieven 2 en 3. */
export function hookVariantVan(b: Pick<RenderBestand, 'hook_variant'>): number {
  return b.hook_variant ?? 1;
}

/** tiktok → tiktok, instagram → reels, youtube → shorts; onbekend → null. */
export function platformUitUrl(url: string): Platform | null {
  return detectPlatform(url);
}

export async function laadRenderJob(id: string): Promise<RenderJobRij | null> {
  const { data, error } = await db().from('render_jobs').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as RenderJobRij | null) ?? null;
}

/**
 * Het clip-plan waarmee deze render gemaakt is: de worker pakt het nieuwste
 * plan op het moment dat hij start. Een later gegenereerd plan hoort er dus
 * niet bij; zonder starttijd valt hij terug op het nieuwste plan.
 */
export async function planVoorRender(job: Pick<RenderJobRij, 'video_id' | 'gestart_at' | 'created_at'>): Promise<{
  id: string;
  plan: PlanRuw;
} | null> {
  if (!job.video_id) return null;
  const supabase = db();
  const moment = job.gestart_at ?? job.created_at;
  const { data: ervoor } = await supabase
    .from('clip_plans')
    .select('id, plan')
    .eq('video_id', job.video_id)
    .lte('created_at', moment)
    .order('created_at', { ascending: false })
    .limit(1);
  if (ervoor?.[0]) return { id: ervoor[0].id as string, plan: ervoor[0].plan as PlanRuw };
  const { data: nieuwste } = await supabase
    .from('clip_plans')
    .select('id, plan')
    .eq('video_id', job.video_id)
    .order('created_at', { ascending: false })
    .limit(1);
  return nieuwste?.[0] ? { id: nieuwste[0].id as string, plan: nieuwste[0].plan as PlanRuw } : null;
}

export type PlanClipRuw = {
  titel_intern?: string;
  structure_type?: string;
  hook?: { type?: string; tekst_overlay?: string };
  hooks?: { type?: string; tekst_overlay?: string }[];
};
export type PlanRuw = { clips?: PlanClipRuw[]; vorm?: string };

/** Structuur en hook van één render-bestand volgens zijn clip-plan. */
export function planInfo(plan: PlanRuw | null | undefined, nummer: number | null, hookVariant: number) {
  const clip = nummer ? plan?.clips?.[nummer - 1] : undefined;
  const variantHook = hookVariant > 1 ? clip?.hooks?.[hookVariant - 1] : undefined;
  return {
    titel: clip?.titel_intern ?? null,
    structure_type: clip?.structure_type ?? null,
    hook_type: variantHook?.type ?? clip?.hook?.type ?? clip?.hooks?.[0]?.type ?? null,
  };
}

/* ------------------------------------------------------------ beoordelen */

export type BeoordelingInvoer = {
  renderJobId: string;
  bestandNaam: string;
  oordeel?: Oordeel;
  reden?: string | null;
  evalCase?: boolean;
  door: string | null;
};

/**
 * Upsert van één oordeel per (render, bestand). Zonder oordeel mag alleen het
 * eval-vinkje of de reden wijzigen, en dan moet er al een oordeel staan: een
 * rij zonder oordeel bestaat niet.
 */
export async function bewaarBeoordeling(inv: BeoordelingInvoer) {
  const job = await laadRenderJob(inv.renderJobId);
  if (!job) throw new LeerlusFout('Render niet gevonden', 404);
  const bestand = (job.bestanden ?? []).find((b) => b.naam === inv.bestandNaam);
  if (!bestand) throw new LeerlusFout('Dit bestand hoort niet bij deze render', 404);
  if (inv.oordeel !== undefined && !OORDELEN.includes(inv.oordeel)) {
    throw new LeerlusFout(`Ongeldig oordeel "${inv.oordeel}"; kies uit ${OORDELEN.join(', ')}.`, 400);
  }

  const supabase = db();
  const reden = inv.reden === undefined ? undefined : inv.reden?.trim().slice(0, 500) || null;
  const nu = new Date().toISOString();

  if (!inv.oordeel) {
    const update: Record<string, unknown> = { updated_at: nu, beoordeeld_door: inv.door };
    if (reden !== undefined) update.reden = reden;
    if (inv.evalCase !== undefined) update.eval_case = inv.evalCase;
    const { data, error } = await supabase
      .from('render_beoordelingen')
      .update(update)
      .eq('render_job_id', job.id)
      .eq('bestand_naam', bestand.naam)
      .select()
      .maybeSingle();
    if (error) throw new LeerlusFout(error.message, 500);
    if (!data) throw new LeerlusFout('Geef eerst een oordeel (goed, matig of weg).', 400);
    return data;
  }

  const rij: Record<string, unknown> = {
    render_job_id: job.id,
    bestand_naam: bestand.naam,
    video_id: job.video_id,
    clip_index: clipNummerUitNaam(bestand.naam, job.clip_index),
    hook_variant: hookVariantVan(bestand),
    oordeel: inv.oordeel,
    beoordeeld_door: inv.door,
    updated_at: nu,
  };
  if (reden !== undefined) rij.reden = reden;
  if (inv.evalCase !== undefined) rij.eval_case = inv.evalCase;

  const { data, error } = await supabase
    .from('render_beoordelingen')
    .upsert(rij, { onConflict: 'render_job_id,bestand_naam' })
    .select()
    .single();
  if (error) throw new LeerlusFout(error.message, 500);
  return data;
}

export class LeerlusFout extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/* ---------------------------------------------------------------- posten */

/**
 * Koppelt een post-URL aan een render-bestand. De clip-rij hoort bij het
 * clip-plan van de render met plan_index = clipnummer − 1 (de planner telt
 * vanaf 0, de worker en render_jobs.clip_index vanaf 1). Bestaat er al een rij
 * voor precies dit bestand, dan werken we die bij; anders nemen we de nog niet
 * geposte plan-rij over, en is die er niet (of al gepost met een andere
 * render), dan komt er een variant-rij bij — net zoals de variant-API dat doet.
 * Vanaf status 'posted' meet de tracking hem vanzelf.
 */
export async function markeerGepost(inv: { renderJobId: string; bestandNaam: string; postUrl: string }) {
  const postUrl = inv.postUrl.trim();
  if (!/^https?:\/\//i.test(postUrl)) throw new LeerlusFout('Plak een volledige link (https://…).', 400);
  const platform = platformUitUrl(postUrl);
  if (!platform) throw new LeerlusFout('Platform niet herkend: alleen TikTok, Instagram en YouTube.', 400);

  const job = await laadRenderJob(inv.renderJobId);
  if (!job) throw new LeerlusFout('Render niet gevonden', 404);
  const bestand = (job.bestanden ?? []).find((b) => b.naam === inv.bestandNaam);
  if (!bestand) throw new LeerlusFout('Dit bestand hoort niet bij deze render', 404);

  const nummer = clipNummerUitNaam(bestand.naam, job.clip_index);
  if (!nummer) throw new LeerlusFout('Clipnummer niet te bepalen uit de bestandsnaam', 400);
  const variant = hookVariantVan(bestand);
  const plan = await planVoorRender(job);
  if (!plan) throw new LeerlusFout('Geen clip-plan gevonden voor deze video', 404);

  const supabase = db();
  const koppeling = {
    post_url: postUrl,
    platform,
    status: 'posted' as const,
    posted_at: new Date().toISOString(),
    render_job_id: job.id,
    render_bestand: bestand.naam,
    hook_variant: variant,
  };

  // 1. Al eerder aan dit bestand gekoppeld: alleen de link bijwerken.
  const { data: bestaand } = await supabase
    .from('clips')
    .select('id, posted_at, post_url')
    .eq('render_job_id', job.id)
    .eq('render_bestand', bestand.naam)
    .limit(1);
  if (bestaand?.[0]) {
    const zelfdeLink = bestaand[0].post_url === postUrl;
    const { data, error } = await supabase
      .from('clips')
      .update({ ...koppeling, posted_at: zelfdeLink ? bestaand[0].posted_at ?? koppeling.posted_at : koppeling.posted_at })
      .eq('id', bestaand[0].id)
      .select()
      .single();
    if (error) throw new LeerlusFout(error.message, 500);
    return data;
  }

  // 2. De plan-rij van deze clip.
  const { data: planRijen, error: planFout } = await supabase
    .from('clips')
    .select('*')
    .eq('clip_plan_id', plan.id)
    .eq('plan_index', nummer - 1)
    .order('created_at');
  if (planFout) throw new LeerlusFout(planFout.message, 500);
  const basis = (planRijen ?? []).find((c) => !c.variant_of) ?? planRijen?.[0] ?? null;
  const info = planInfo(plan.plan, nummer, variant);

  // Een vrije rij: nog niet gepost en (voor een hookvariant) met die variant
  // of nog zonder variant. De hoofdversie pakt de basisrij.
  const vrij = (planRijen ?? []).find(
    (c) =>
      !c.post_url &&
      c.status !== 'posted' &&
      (variant === 1 ? !c.variant_of : Boolean(c.variant_of) && c.hook_variant === variant),
  );
  if (vrij) {
    const { data, error } = await supabase.from('clips').update(koppeling).eq('id', vrij.id).select().single();
    if (error) throw new LeerlusFout(error.message, 500);
    return data;
  }

  // 3. Nieuwe rij, vorm zoals planner/run.ts en de variant-API hem aanmaken.
  const hookType = await geldigeHook(info.hook_type, basis?.hook_type ?? null);
  const nieuw = {
    clip_plan_id: plan.id,
    plan_index: nummer - 1,
    titel_intern:
      (basis?.titel_intern ?? info.titel ?? bestand.naam) + (variant > 1 ? ` (hookvariant ${variant})` : ''),
    structure_type: basis?.structure_type ?? (await geldigeStructuur(info.structure_type)),
    hook_type: hookType,
    hook_text: bestand.hook_tekst ?? basis?.hook_text ?? null,
    variant_of: basis?.id ?? null,
    ...koppeling,
  };
  const { data, error } = await supabase.from('clips').insert(nieuw).select().single();
  if (error) throw new LeerlusFout(error.message, 500);
  return data;
}

/** hook_type is een foreign key naar vault_hooks; een onbekende slug zou de insert laten klappen. */
async function geldigeHook(voorkeur: string | null, terugval: string | null): Promise<string | null> {
  if (!voorkeur) return terugval;
  const { data } = await db().from('vault_hooks').select('slug').eq('slug', voorkeur).maybeSingle();
  return data ? voorkeur : terugval;
}

async function geldigeStructuur(slug: string | null): Promise<string | null> {
  if (!slug) return null;
  const { data } = await db().from('vault_structures').select('slug').eq('slug', slug).maybeSingle();
  return data ? slug : null;
}

/* ------------------------------------------------------ voor het paneel */

export type BestandFeedback = {
  beoordeling: { oordeel: Oordeel; reden: string | null; eval_case: boolean; beoordeeld_door: string | null } | null;
  gepost: {
    clip_id: string;
    post_url: string;
    platform: string | null;
    posted_at: string | null;
    views_24h: number | null;
    views_7d: number | null;
  } | null;
};

/**
 * Oordeel en post-status per (render, bestand) voor een reeks renders. Mislukt
 * een query (bv. migratie nog niet gedraaid), dan gewoon lege feedback: het
 * downloaden mag daar nooit op stuklopen.
 */
export async function feedbackVoorRenders(jobIds: string[]): Promise<Map<string, BestandFeedback>> {
  const uit = new Map<string, BestandFeedback>();
  if (jobIds.length === 0) return uit;
  const supabase = db();
  const [oordelen, clips] = await Promise.all([
    supabase
      .from('render_beoordelingen')
      .select('render_job_id, bestand_naam, oordeel, reden, eval_case, beoordeeld_door')
      .in('render_job_id', jobIds),
    supabase
      .from('clips')
      .select('id, render_job_id, render_bestand, post_url, platform, posted_at, clip_performance(views_24h, views_7d)')
      .in('render_job_id', jobIds),
  ]);
  const sleutel = (job: string, naam: string) => `${job}|${naam}`;
  const pak = (k: string) => {
    const f = uit.get(k) ?? { beoordeling: null, gepost: null };
    uit.set(k, f);
    return f;
  };
  for (const o of oordelen.data ?? []) {
    pak(sleutel(o.render_job_id as string, o.bestand_naam as string)).beoordeling = {
      oordeel: o.oordeel as Oordeel,
      reden: (o.reden as string | null) ?? null,
      eval_case: Boolean(o.eval_case),
      beoordeeld_door: (o.beoordeeld_door as string | null) ?? null,
    };
  }
  for (const c of clips.data ?? []) {
    if (!c.post_url || !c.render_bestand) continue;
    const perf = one<{ views_24h: number | null; views_7d: number | null }>(c.clip_performance);
    pak(sleutel(c.render_job_id as string, c.render_bestand as string)).gepost = {
      clip_id: c.id as string,
      post_url: c.post_url as string,
      platform: (c.platform as string | null) ?? null,
      posted_at: (c.posted_at as string | null) ?? null,
      views_24h: perf?.views_24h ?? null,
      views_7d: perf?.views_7d ?? null,
    };
  }
  return uit;
}

/* -------------------------------------------------------------- eval-set */

export type EvalPaar = {
  beoordeling_id: string;
  origineel_job: string;
  bestand_naam: string;
  video_id: string;
  clip_index: number;
  hook_variant: number;
  oordeel: Oordeel;
  reden: string | null;
  /** De nieuwe render met de huidige code (null bij --alleen-meten zonder nieuwere render). */
  nieuw_job: string | null;
};

/** Beoordelingen die in de eval-set staan, met wat nodig is om ze opnieuw te renderen. */
export async function laadEvalCases(): Promise<EvalPaar[]> {
  const { data, error } = await db()
    .from('render_beoordelingen')
    .select('id, render_job_id, bestand_naam, video_id, clip_index, hook_variant, oordeel, reden')
    .eq('eval_case', true)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((b) => b.video_id && b.clip_index)
    .map((b) => ({
      beoordeling_id: b.id as string,
      origineel_job: b.render_job_id as string,
      bestand_naam: b.bestand_naam as string,
      video_id: b.video_id as string,
      clip_index: b.clip_index as number,
      hook_variant: (b.hook_variant as number | null) ?? 1,
      oordeel: b.oordeel as Oordeel,
      reden: (b.reden as string | null) ?? null,
      nieuw_job: null,
    }));
}

/**
 * Eval-modus 1: per eval-case een nieuwe render_job met de huidige code
 * klaarzetten (zelfde video en clip, titel "EVAL …"). Wacht niet: de cloud
 * pakt ze op zoals elke render, en `npm run eval:smaak -- --uitslag`
 * vergelijkt ze zodra ze klaar zijn. Hookvarianten van dezelfde clip delen
 * één render. Blokkeert nooit iets; niets draait dit vanzelf.
 */
export async function zetEvalRendersKlaar(opties: { droog?: boolean; door?: string | null } = {}): Promise<{
  runId: string | null;
  paren: EvalPaar[];
  nieuweJobs: number;
}> {
  const cases = await laadEvalCases();
  if (cases.length === 0) return { runId: null, paren: [], nieuweJobs: 0 };
  const supabase = db();
  const perClip = new Map<string, string | null>();
  let nieuweJobs = 0;
  const stempel = new Date().toLocaleDateString('nl-NL');

  for (const c of cases) {
    const k = `${c.video_id}|${c.clip_index}`;
    if (!perClip.has(k)) {
      if (opties.droog) {
        perClip.set(k, null);
      } else {
        // Staat er al een render van deze clip in de wachtrij, dan die gebruiken.
        const { data: lopend } = await supabase
          .from('render_jobs')
          .select('id')
          .eq('video_id', c.video_id)
          .eq('clip_index', c.clip_index)
          .in('status', ['wachtend', 'bezig'])
          .limit(1);
        if (lopend?.[0]) {
          perClip.set(k, lopend[0].id as string);
        } else {
          const { data, error } = await supabase
            .from('render_jobs')
            .insert({
              video_id: c.video_id,
              clip_index: c.clip_index,
              titel: `EVAL ${stempel} · clip ${c.clip_index} (vgl. ${c.origineel_job.slice(0, 8)})`,
              aangevraagd_door: opties.door ?? 'eval:smaak',
            })
            .select('id')
            .single();
          if (error) throw new Error(`render_job klaarzetten mislukt: ${error.message}`);
          perClip.set(k, data.id as string);
          nieuweJobs++;
        }
      }
    }
    c.nieuw_job = perClip.get(k) ?? null;
  }

  if (opties.droog) return { runId: null, paren: cases, nieuweJobs: perClip.size };

  const { data: run, error } = await supabase
    .from('smaak_eval_runs')
    .insert({
      config: { modus: 'klaarzetten', paren: cases, door: opties.door ?? null },
      uitslag: { status: 'klaargezet', klaargezet_op: new Date().toISOString() },
    })
    .select('id')
    .single();
  if (error) throw new Error(`smaak_eval_runs insert mislukt: ${error.message}`);
  await startRenderCloudRun();
  return { runId: run.id as string, paren: cases, nieuweJobs };
}

/**
 * Geeft de render-workflow meteen een zetje in plaats van te wachten op de
 * kwartiercheck. Best-effort: faalt dit, dan pakt de geplande run de opdracht
 * alsnog op — de wachtrij is de waarheid, dit is alleen de versneller.
 */
export async function startRenderCloudRun(): Promise<boolean> {
  const token = optionalEnv('GH_DISPATCH_TOKEN');
  if (!token) return false;
  try {
    const repo = optionalEnv('GH_REPO', 'BenxFPG1/clipper-os');
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/roughcut.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'master' }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}
