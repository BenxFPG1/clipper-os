import { z } from 'zod';
import { structuredCall } from '../claude';
import { AGENT_EFFORT } from '../env';
import { db, one } from '../supabase';
import { ALL, loadVault, loadWeights, renderVaultForPrompt, upsertWeight } from '../vault';
import { median } from '../tracking/performance';
import { clipNummerUitNaam, planInfo, planVoorRender, type RenderJobRij } from '../tracking/leerlus';

/** Minimum aantal waarnemingen per kant (eigen of extern) om mee te tellen. */
export const MIN_N_PER_GROUP = 5;
export const MAX_WEIGHT_STEP = 0.15;
/**
 * Hoe zwaar eigen resultaten wegen tegenover wat we buiten zien. 0.5 = gelijk:
 * de vault leert net zo hard van werkende content van anderen als van onszelf.
 */
export const EIGEN_GEWICHT = 0.5;
/**
 * Externe vondsten ouder dan dit tellen niet meer mee. Wat drie maanden
 * geleden werkte is geen meting van nu; de scout ziet de post bovendien
 * opnieuw als hij nog steeds uitschiet.
 */
export const EXTERN_VENSTER_DAGEN = 90;
/**
 * Een kandidaat-heuristiek van de scout wordt pas actief als hij bij zoveel
 * verschillende accounts terugkwam. Eén account is een stijl, drie is een
 * patroon.
 */
export const MIN_ACCOUNTS_VOOR_ACTIVATIE = 3;
/**
 * Oudere kandidaten hebben geen bewijs-kolom; daar valt de toets terug op de
 * evidence_score (posts x accounts). 9 = minstens drie accounts met elk
 * minstens drie posts, of drie posts van drie accounts.
 */
export const MIN_EVIDENCE_SCORE_ZONDER_BEWIJS = 9;
/**
 * Eigen oordelen (goed/matig/weg over renders) zijn een zwakker signaal dan
 * views: het is smaak, geen publiek. Ze tellen niet mee voor de drempel en
 * sturen de gecombineerde score hooguit een fractie bij — genoeg om bij twee
 * gelijke slugs de doorslag te geven, nooit genoeg om eigen of externe
 * cijfers om te draaien.
 */
export const SMAAK_GEWICHT = 0.15;
/** Pas vanaf zoveel oordelen over een slug telt het smaaksignaal mee. */
export const MIN_SMAAK_N = 3;

const proposalSchema = z.object({
  wijzigingen: z.array(
    z.object({
      entity: z.enum(['structure', 'hook']),
      slug: z.string(),
      platform: z.string(),
      theme: z.string(),
      huidig_gewicht: z.number(),
      nieuw_gewicht: z.number(),
      reden: z.string(),
      bewijs_clip_ids: z.array(z.string()),
      bewijs_post_urls: z.array(z.string()),
    }),
  ),
  heuristiek_activaties: z
    .array(
      z.object({
        id: z.string().describe('Het id van de kandidaat-heuristiek.'),
        reden: z.string().describe('Waarom deze regel de toets doorstaat, met de accounts erbij.'),
      }),
    )
    .default([])
    .describe('Kandidaat-heuristieken die actief mogen worden. Alleen uit de lijst met toetsbaar=true.'),
  samenvatting: z.string(),
});

export type RetroProposal = z.infer<typeof proposalSchema>;

export type GroupStats = {
  entity: 'structure' | 'hook';
  slug: string;
  platform: string;
  theme: string;
  eigen_n: number;
  eigen_mediaan: number | null;
  extern_n: number;
  extern_mediaan: number | null;
  /** Gecombineerde score: 50% eigen, 50% extern (zie EIGEN_GEWICHT), licht bijgestuurd door smaak (SMAAK_GEWICHT). */
  gecombineerde_score: number | null;
  /** Aantal eigen oordelen over renders met deze slug (alleen op platform/thema 'all'). */
  smaak_n: number;
  /** Gemiddeld oordeel: goed = +1, matig = 0, weg = −1. Null onder MIN_SMAAK_N. */
  smaak_score: number | null;
  smaak_redenen: string[];
  huidig_gewicht: number;
  clip_ids: string[];
  post_urls: string[];
};

export type HeuristiekKandidaat = {
  id: string;
  rule: string;
  platform: string | null;
  theme: string | null;
  evidence_score: number;
  accounts: string[];
  post_urls: string[];
  /** Haalt de mechanische drempel (accounts of evidence_score). */
  toetsbaar: boolean;
};

const RETRO_SYSTEM = `Je bent de Retro-agent van een clipping-tool. Je krijgt prestatiecijfers per structuur- en hook-type, uitgesplitst naar platform en thema, de huidige vault (met gewichten), de laatste gewichtswijzigingen, en de kandidaat-craftregels die de scout verzamelde. Je stelt gewichtswijzigingen en activaties voor.

Belangrijk: de cijfers komen uit twee bronnen die even zwaar wegen.
- eigen_mediaan: hoe onze eigen geposte clips presteerden (outlier-score t.o.v. onze mediaan).
- extern_mediaan: hoe dezelfde structuur/hook presteerde bij andere accounts die de scout vond. Let op: de scout bewaart alleen posts die al uitschieters waren, dus extern_mediaan ligt per definitie boven 1. Vergelijk slugs daarom ONDERLING (welke scoort hoger dan de andere, met meer waarnemingen), niet tegen de grens van 1.
De gecombineerde_score is het gewogen gemiddelde van beide, licht bijgestuurd (hooguit ±${Math.round(SMAAK_GEWICHT * 100)}%) door ons eigen oordeel over de renders.

Twee extra, zwakkere signalen:
- smaak_score (−1 = alles 'weg', +1 = alles 'goed'): hoe de makers zelf renders met deze structuur/hook beoordeelden, met hun redenen. Dat is smaak, geen publiek. Gebruik het alleen als tie-breaker of als bevestiging van een richting die de cijfers al geven; nooit als enige grond, en nooit tegen eigen én externe cijfers in. Zeg in de reden als smaak meewoog.
- hookvarianten: dezelfde montage met een andere hook, allemaal gepost. Hét zuiverste bewijs voor hooks, maar met weinig waarnemingen: benoem het, en laat één paar geen gewicht omdraaien dat door veel externe data gedragen wordt.

Harde regels:
- Stel alleen een wijziging voor als eigen_n >= ${MIN_N_PER_GROUP} of extern_n >= ${MIN_N_PER_GROUP}. Je krijgt alleen die groepen.
- De stap is maximaal ${MAX_WEIGHT_STEP} omhoog of omlaag per run.
- Gewichten blijven tussen 0 en 1.
- Elk voorstel geldt voor precies één combinatie van platform en thema; die neem je letterlijk over uit de data.
- Onderbouw met de clip_ids en post_urls uit de groep.
- Wat op het ene platform werkt hoeft op het andere niet te werken; behandel elke combinatie los.
- Steunt een voorstel maar op één bron, zeg dat dan expliciet in de reden. Ontbreekt eigen data helemaal, benoem dat in de samenvatting.
- Kijk naar de laatste wijzigingen: een gewicht dat vorige week omhoog ging niet deze week weer omlaag zonder nieuwe data.
- Kandidaat-heuristieken: activeer alleen wat toetsbaar=true heeft én concreet genoeg is om tijdens het editen toe te passen. Een vage regel activeer je niet, ook niet met veel bewijs.
- Geen duidelijke richting? Dan stel je niets voor; lege lijsten zijn een geldig antwoord.`;

/**
 * Verzamelt prestaties per (structuur/hook × platform × thema) uit twee bronnen:
 * onze eigen geposte clips én de gedecodeerde vondsten van de scout. Beide
 * tellen even zwaar mee, zodat de vault ook leert van content die wij nooit
 * gemaakt hebben.
 */
export async function collectRetroStats(): Promise<GroupStats[]> {
  const supabase = db();
  const smaak = await collectSmaakSignaal().catch(() => new Map<string, SmaakBucket>());
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const externSinds = new Date(Date.now() - EXTERN_VENSTER_DAGEN * 24 * 3600 * 1000).toISOString();

  const [eigenRes, externRes, weights] = await Promise.all([
    supabase
      .from('clips')
      .select('id, structure_type, hook_type, platform, theme, posted_at, clip_performance(outlier_score)')
      .eq('status', 'posted')
      .lte('posted_at', sevenDaysAgo),
    supabase
      .from('scout_finds')
      .select('post_url, platform, theme, outlier_score, decoded')
      .not('decoded', 'is', null)
      .eq('is_basislijn', false)
      .gte('created_at', externSinds),
    loadWeights(),
  ]);
  if (eigenRes.error) throw eigenRes.error;
  if (externRes.error) throw externRes.error;

  type Bucket = {
    entity: 'structure' | 'hook';
    slug: string;
    platform: string;
    theme: string;
    eigen: number[];
    extern: number[];
    clipIds: string[];
    postUrls: string[];
  };
  const buckets = new Map<string, Bucket>();

  const bucket = (entity: 'structure' | 'hook', slug: string, platform: string, theme: string): Bucket => {
    const k = `${entity}|${slug}|${platform}|${theme}`;
    const bestaand = buckets.get(k);
    if (bestaand) return bestaand;
    const nieuw: Bucket = { entity, slug, platform, theme, eigen: [], extern: [], clipIds: [], postUrls: [] };
    buckets.set(k, nieuw);
    return nieuw;
  };

  // Eigen clips.
  for (const clip of eigenRes.data ?? []) {
    const perf = one<{ outlier_score: number | null }>(clip.clip_performance);
    if (perf?.outlier_score === null || perf?.outlier_score === undefined) continue;
    const score = Number(perf.outlier_score);
    const platform = (clip.platform as string) ?? ALL;
    const theme = (clip.theme as string) ?? ALL;

    for (const [entity, slug] of [
      ['structure', clip.structure_type],
      ['hook', clip.hook_type],
    ] as const) {
      if (!slug) continue;
      // Elke waarneming telt mee op zijn eigen niveau én op het algemene niveau,
      // zodat brede terugval-gewichten ook blijven leren.
      for (const [p, t] of [
        [platform, theme],
        [platform, ALL],
        [ALL, ALL],
      ] as const) {
        const b = bucket(entity, slug, p, t);
        b.eigen.push(score);
        b.clipIds.push(clip.id as string);
      }
    }
  }

  // Externe vondsten van de scout.
  for (const find of externRes.data ?? []) {
    if (find.outlier_score === null) continue;
    const score = Number(find.outlier_score);
    const decoded = (find.decoded ?? {}) as { hook_type?: string; structuur?: string; overdraagbaar_naar_ons?: boolean };
    // Bewust géén filter op "overdraagbaar": een hook die in financien werkt is
    // een echte meting, ook als hij niet direct op ons materiaal past. Relevantie
    // regelen we via het thema — die kennis telt zwaar mee bij een financien-
    // campagne en licht bij comedy. Weggooien zou signaal vernietigen.

    const platform = (find.platform as string) ?? ALL;
    const theme = (find.theme as string) ?? ALL;

    for (const [entity, ruwe] of [
      ['structure', decoded.structuur],
      ['hook', decoded.hook_type],
    ] as const) {
      // De scout mag "nieuw:..." teruggeven voor iets dat nog niet in de vault
      // staat; dat is een kandidaat, geen gewicht voor een bestaande slug.
      if (!ruwe || ruwe.startsWith('nieuw:')) continue;
      for (const [p, t] of [
        [platform, theme],
        [platform, ALL],
        [ALL, ALL],
      ] as const) {
        const b = bucket(entity, ruwe, p, t);
        b.extern.push(score);
        b.postUrls.push(find.post_url as string);
      }
    }
  }

  // Het smaaksignaal hangt alleen aan het algemene niveau: oordelen zijn per
  // render, niet per platform, en per thema zijn het er te weinig.
  for (const k of smaak.keys()) {
    const [entity, slug] = k.split('|') as ['structure' | 'hook', string];
    bucket(entity, slug, ALL, ALL);
  }

  return [...buckets.values()].map((b) => {
    const eigenMediaan = median(b.eigen);
    const externMediaan = median(b.extern);
    const sb = b.platform === ALL && b.theme === ALL ? smaak.get(`${b.entity}|${b.slug}`) : undefined;
    const smaakScore = sb && sb.n >= MIN_SMAAK_N ? Math.round((sb.som / sb.n) * 100) / 100 : null;
    return {
      entity: b.entity,
      slug: b.slug,
      platform: b.platform,
      theme: b.theme,
      eigen_n: b.eigen.length,
      eigen_mediaan: eigenMediaan,
      extern_n: b.extern.length,
      extern_mediaan: externMediaan,
      gecombineerde_score: bijsturenMetSmaak(combineer(eigenMediaan, externMediaan), smaakScore),
      smaak_n: sb?.n ?? 0,
      smaak_score: smaakScore,
      smaak_redenen: (sb?.redenen ?? []).slice(0, 5),
      huidig_gewicht: weights.resolve(b.entity, b.slug, b.platform, b.theme).weight,
      clip_ids: [...new Set(b.clipIds)],
      post_urls: [...new Set(b.postUrls)],
    };
  });
}

/** 50/50 als beide kanten data hebben; anders telt de kant die er wel is. */
export function combineer(eigen: number | null, extern: number | null): number | null {
  if (eigen === null && extern === null) return null;
  if (eigen === null) return extern;
  if (extern === null) return eigen;
  return EIGEN_GEWICHT * eigen + (1 - EIGEN_GEWICHT) * extern;
}

/**
 * Smaak stuurt alleen bij waar er al een score is uit eigen of externe views:
 * ±SMAAK_GEWICHT relatief (goed overal = ×1.15, weg overal = ×0.85). Zonder
 * cijfers blijft de score leeg — een oordeel alleen verschuift geen gewicht.
 */
export function bijsturenMetSmaak(score: number | null, smaakScore: number | null): number | null {
  if (score === null || smaakScore === null) return score;
  return Math.round(score * (1 + SMAAK_GEWICHT * smaakScore) * 1000) / 1000;
}

type SmaakBucket = { n: number; som: number; redenen: string[] };

/**
 * Eigen oordelen over renders, teruggevoerd op structuur en hook via het
 * clip-plan waarmee de render gemaakt is. Een hookvariant telt voor zijn
 * eigen hook; de structuur is voor alle varianten dezelfde.
 */
export async function collectSmaakSignaal(): Promise<Map<string, SmaakBucket>> {
  const supabase = db();
  const uit = new Map<string, SmaakBucket>();
  const { data: oordelen, error } = await supabase
    .from('render_beoordelingen')
    .select('render_job_id, bestand_naam, clip_index, hook_variant, oordeel, reden');
  if (error || !oordelen?.length) return uit;

  const jobIds = [...new Set(oordelen.map((o) => o.render_job_id as string))];
  const { data: jobs } = await supabase
    .from('render_jobs')
    .select('id, video_id, clip_index, titel, status, bestanden, created_at, gestart_at, klaar_at')
    .in('id', jobIds);
  const plannen = new Map<string, Awaited<ReturnType<typeof planVoorRender>>>();
  for (const job of (jobs ?? []) as RenderJobRij[]) plannen.set(job.id, await planVoorRender(job).catch(() => null));

  const WAARDE = { goed: 1, matig: 0, weg: -1 } as const;
  for (const o of oordelen) {
    const plan = plannen.get(o.render_job_id as string);
    if (!plan) continue;
    const nummer = (o.clip_index as number | null) ?? clipNummerUitNaam(o.bestand_naam as string);
    const info = planInfo(plan.plan, nummer, (o.hook_variant as number | null) ?? 1);
    const waarde = WAARDE[o.oordeel as keyof typeof WAARDE] ?? 0;
    for (const [entity, slug] of [
      ['structure', info.structure_type],
      ['hook', info.hook_type],
    ] as const) {
      if (!slug) continue;
      const k = `${entity}|${slug}`;
      const sb = uit.get(k) ?? { n: 0, som: 0, redenen: [] };
      sb.n++;
      sb.som += waarde;
      if (o.reden) sb.redenen.push(`${o.oordeel}: ${String(o.reden).slice(0, 120)}`);
      uit.set(k, sb);
    }
  }
  return uit;
}

export type HookVariantVergelijking = {
  render_job_id: string;
  clip: number | null;
  varianten: {
    hook_variant: number;
    hook_type: string | null;
    hook_text: string | null;
    platform: string | null;
    views_24h: number | null;
    views_7d: number | null;
  }[];
};

/**
 * Hookvarianten van dezelfde render die allebei gepost zijn: dezelfde montage,
 * alleen een andere hook. Zuiverder A/B-bewijs voor hooks bestaat hier niet.
 */
export async function collectHookVariantVergelijking(): Promise<HookVariantVergelijking[]> {
  const { data, error } = await db()
    .from('clips')
    .select('render_job_id, render_bestand, hook_variant, hook_type, hook_text, platform, clip_performance(views_24h, views_7d)')
    .not('render_job_id', 'is', null)
    .eq('status', 'posted');
  if (error) return [];
  const groepen = new Map<string, HookVariantVergelijking>();
  for (const c of data ?? []) {
    const clip = clipNummerUitNaam((c.render_bestand as string | null) ?? '');
    const k = `${c.render_job_id}|${clip}`;
    const g = groepen.get(k) ?? { render_job_id: c.render_job_id as string, clip, varianten: [] };
    const perf = one<{ views_24h: number | null; views_7d: number | null }>(c.clip_performance);
    g.varianten.push({
      hook_variant: (c.hook_variant as number | null) ?? 1,
      hook_type: (c.hook_type as string | null) ?? null,
      hook_text: (c.hook_text as string | null) ?? null,
      platform: (c.platform as string | null) ?? null,
      views_24h: perf?.views_24h ?? null,
      views_7d: perf?.views_7d ?? null,
    });
    groepen.set(k, g);
  }
  return [...groepen.values()].filter((g) => new Set(g.varianten.map((v) => v.hook_variant)).size >= 2);
}

/**
 * De kandidaat-craftregels van de scout, met de mechanische toets erbij. De
 * scout schrijft ze weg als 'candidate'; niemand zette ze ooit op 'active',
 * dus alles wat de scout leerde aan regels bereikte de planner niet.
 */
export async function collectHeuristiekKandidaten(): Promise<HeuristiekKandidaat[]> {
  const { data } = await db().from('vault_heuristics').select('*').eq('status', 'candidate');
  return (data ?? []).map((h) => {
    const bewijs = (h.evidence ?? {}) as { accounts?: unknown; post_urls?: unknown };
    const accounts = Array.isArray(bewijs.accounts) ? (bewijs.accounts as string[]) : [];
    const postUrls = Array.isArray(bewijs.post_urls) ? (bewijs.post_urls as string[]) : [];
    const score = Number(h.evidence_score ?? 0);
    return {
      id: h.id as string,
      rule: h.rule as string,
      platform: (h.platform as string | null) ?? null,
      theme: (h.theme as string | null) ?? null,
      evidence_score: score,
      accounts,
      post_urls: postUrls,
      toetsbaar: toetsHeuristiek(accounts.length, score),
    };
  });
}

/** Puur en testbaar: genoeg verschillende accounts, of (zonder bewijs-kolom) genoeg evidence_score. */
export function toetsHeuristiek(aantalAccounts: number, evidenceScore: number): boolean {
  if (aantalAccounts >= MIN_ACCOUNTS_VOOR_ACTIVATIE) return true;
  return aantalAccounts === 0 && evidenceScore >= MIN_EVIDENCE_SCORE_ZONDER_BEWIJS;
}

/**
 * Draait de wekelijkse retro en zet het voorstel klaar in de agent-inbox.
 * De agent muteert nooit zelf de vault — Antonie keurt goed (sectie 3, principe 4).
 */
export async function runRetroAgent(): Promise<{ agentRunId: string; proposal: RetroProposal; stats: GroupStats[] }> {
  const stats = await collectRetroStats();
  const eligible = stats.filter((s) => s.eigen_n >= MIN_N_PER_GROUP || s.extern_n >= MIN_N_PER_GROUP);
  const kandidaten = await collectHeuristiekKandidaten();
  const toetsbaar = kandidaten.filter((k) => k.toetsbaar);
  const hookVarianten = await collectHookVariantVergelijking().catch(() => []);
  const smaakGroepen = stats.filter((s) => s.smaak_score !== null);
  const eigenDataOntbreekt = !stats.some((s) => s.eigen_n >= MIN_N_PER_GROUP);

  let proposal: RetroProposal;
  if (eligible.length === 0 && toetsbaar.length === 0) {
    proposal = {
      wijzigingen: [],
      heuristiek_activaties: [],
      samenvatting: `Geen enkele groep haalt de drempel van ${MIN_N_PER_GROUP} waarnemingen (eigen clips of externe vondsten) en geen kandidaat-heuristiek haalt de toets. Nog geen voorstel.`,
    };
  } else {
    const supabase = db();
    const [vault, changelog] = await Promise.all([
      loadVault(),
      supabase
        .from('vault_changelog')
        .select('entity_key, field, old_value, new_value, reason, created_at')
        .order('created_at', { ascending: false })
        .limit(5),
    ]);
    const laatsteWijzigingen = (changelog.data ?? [])
      .map(
        (c) =>
          `- ${new Date(c.created_at as string).toLocaleDateString('nl-NL')} ${c.entity_key} ${c.field}: ${JSON.stringify(c.old_value)} → ${JSON.stringify(c.new_value)} (${String(c.reason ?? '').slice(0, 120)})`,
      )
      .join('\n');

    proposal = enforceRules(
      await structuredCall({
        system: RETRO_SYSTEM,
        user: `=== ONZE VAULT (huidige gewichten) ===
${renderVaultForPrompt(vault)}

=== LAATSTE GEWICHTSWIJZIGINGEN ===
${laatsteWijzigingen || '— (nog geen)'}

=== GROEPEN DIE DE DREMPEL HALEN (${eligible.length}) ===
${eigenDataOntbreekt ? `Let op: geen enkele groep heeft eigen_n >= ${MIN_N_PER_GROUP}. Alles hieronder steunt uitsluitend op externe vondsten.\n` : ''}${JSON.stringify(eligible, null, 1)}

=== EIGEN SMAAK (zwak signaal; ${smaakGroepen.length} slugs met >= ${MIN_SMAAK_N} oordelen) ===
${
  smaakGroepen.length
    ? JSON.stringify(
        smaakGroepen.map((g) => ({
          entity: g.entity,
          slug: g.slug,
          smaak_n: g.smaak_n,
          smaak_score: g.smaak_score,
          redenen: g.smaak_redenen,
          heeft_cijfers: g.eigen_n >= MIN_N_PER_GROUP || g.extern_n >= MIN_N_PER_GROUP,
        })),
        null,
        1,
      )
    : '— (nog te weinig oordelen)'
}

=== HOOKVARIANTEN VAN DEZELFDE RENDER, ALLEMAAL GEPOST (${hookVarianten.length}) ===
${hookVarianten.length ? JSON.stringify(hookVarianten, null, 1) : '— (nog geen geposte varianten naast elkaar)'}

=== KANDIDAAT-HEURISTIEKEN VAN DE SCOUT (${kandidaten.length}, waarvan ${toetsbaar.length} toetsbaar) ===
${JSON.stringify(
  kandidaten.map((k) => ({
    id: k.id,
    regel: k.rule,
    platform: k.platform,
    thema: k.theme,
    accounts: k.accounts,
    posts: k.post_urls.length,
    evidence_score: k.evidence_score,
    toetsbaar: k.toetsbaar,
  })),
  null,
  1,
)}`,
        schema: proposalSchema,
        toolName: 'lever_vault_voorstel',
        toolDescription: 'Lever de voorgestelde vault-gewichtswijzigingen en heuristiek-activaties met bewijs.',
        maxTokens: 16000,
        effort: AGENT_EFFORT,
        operation: 'retro_agent',
      }),
      eligible,
      toetsbaar,
    );
  }

  // Ontbrekende eigen data is de belangrijkste kanttekening bij elk voorstel;
  // die zetten we mechanisch voorop, ongeacht wat het model schreef.
  if (eigenDataOntbreekt && proposal.wijzigingen.length > 0) {
    proposal.samenvatting = `Zonder eigen data (geen groep met eigen_n >= ${MIN_N_PER_GROUP}; er zijn nog te weinig geposte clips met metingen) steunen alle voorstellen uitsluitend op externe vondsten. ${proposal.samenvatting}`;
  }

  const { data, error } = await db()
    .from('agent_runs')
    .insert({
      agent: 'retro',
      input_summary: {
        groepen: stats.length,
        in_aanmerking: eligible.length,
        eigen_data_ontbreekt: eigenDataOntbreekt,
        kandidaat_heuristieken: kandidaten.length,
        toetsbaar: toetsbaar.length,
        smaak_groepen: smaakGroepen.length,
        hookvarianten: hookVarianten,
        stats,
        heuristieken: kandidaten,
      },
      proposal,
      // Een run zonder wijzigingen vraagt niets van je; die hoort in de historie,
      // niet in de inbox. Anders staat er elke week een leeg voorstel te wachten.
      status: proposal.wijzigingen.length > 0 || proposal.heuristiek_activaties.length > 0 ? 'pending' : 'auto',
    })
    .select()
    .single();
  if (error) throw error;

  return { agentRunId: data.id, proposal, stats };
}

/**
 * De regels uit sectie 10 worden in code afgedwongen, niet alleen in de prompt:
 * onvoldoende data of een te grote stap wordt hier gecorrigeerd of geweigerd,
 * en een activatie van een niet-toetsbare heuristiek valt af.
 */
function enforceRules(proposal: RetroProposal, eligible: GroupStats[], toetsbaar: HeuristiekKandidaat[]): RetroProposal {
  const byKey = new Map(eligible.map((s) => [`${s.entity}:${s.slug}:${s.platform}:${s.theme}`, s]));

  const wijzigingen = proposal.wijzigingen
    .map((w) => {
      const stat = byKey.get(`${w.entity}:${w.slug}:${w.platform}:${w.theme}`);
      if (!stat) return null;

      const current = stat.huidig_gewicht;
      const clamped = Math.min(
        Math.max(w.nieuw_gewicht, current - MAX_WEIGHT_STEP, 0),
        current + MAX_WEIGHT_STEP,
        1,
      );
      if (Math.abs(clamped - current) < 0.005) return null;

      return {
        ...w,
        huidig_gewicht: current,
        nieuw_gewicht: Math.round(clamped * 100) / 100,
        bewijs_clip_ids: stat.clip_ids,
        bewijs_post_urls: stat.post_urls,
      };
    })
    .filter((w): w is NonNullable<typeof w> => w !== null);

  const toegestaan = new Set(toetsbaar.map((k) => k.id));
  const gezien = new Set<string>();
  const heuristiek_activaties = proposal.heuristiek_activaties.filter((a) => {
    if (!toegestaan.has(a.id) || gezien.has(a.id)) return false;
    gezien.add(a.id);
    return true;
  });

  return { ...proposal, wijzigingen, heuristiek_activaties };
}

/** Voert een goedgekeurd voorstel uit: gewicht bijwerken, version bumpen, heuristieken activeren, changelog schrijven. */
export async function applyRetroProposal(agentRunId: string, decidedBy: string) {
  const supabase = db();

  const { data: run, error } = await supabase.from('agent_runs').select('*').eq('id', agentRunId).single();
  if (error) throw error;
  if (run.status !== 'pending') throw new Error(`Voorstel is al ${run.status}`);

  const proposal = proposalSchema.parse(run.proposal);
  const stats = ((run.input_summary as { stats?: GroupStats[] })?.stats ?? []) as GroupStats[];
  const statFor = (w: RetroProposal['wijzigingen'][number]) =>
    stats.find(
      (s) => s.entity === w.entity && s.slug === w.slug && s.platform === w.platform && s.theme === w.theme,
    );

  for (const w of proposal.wijzigingen) {
    const stat = statFor(w);

    await upsertWeight({
      entity: w.entity,
      entity_key: w.slug,
      platform: w.platform,
      theme: w.theme,
      weight: w.nieuw_gewicht,
      eigen_n: stat?.eigen_n ?? 0,
      eigen_mediaan: stat?.eigen_mediaan ?? null,
      extern_n: stat?.extern_n ?? 0,
      extern_mediaan: stat?.extern_mediaan ?? null,
      evidence: {
        clip_ids: w.bewijs_clip_ids,
        post_urls: w.bewijs_post_urls,
        reden: w.reden,
        agent_run_id: agentRunId,
      },
    });

    await supabase.from('vault_changelog').insert({
      entity: w.entity,
      entity_key: `${w.slug} (${w.platform}/${w.theme})`,
      field: 'weight',
      old_value: w.huidig_gewicht,
      new_value: w.nieuw_gewicht,
      reason: w.reden,
      evidence: { clip_ids: w.bewijs_clip_ids, post_urls: w.bewijs_post_urls },
      agent_run_id: agentRunId,
      decided_by: decidedBy,
    });
  }

  // Heuristieken activeren: vanaf nu gaan ze via loadVault mee in elke
  // plan- en scriptcall als craft-regel.
  let geactiveerd = 0;
  for (const a of proposal.heuristiek_activaties) {
    const { data: h } = await supabase.from('vault_heuristics').select('id, rule, status').eq('id', a.id).maybeSingle();
    if (!h || h.status !== 'candidate') continue;
    const { error: updErr } = await supabase.from('vault_heuristics').update({ status: 'active' }).eq('id', a.id);
    if (updErr) continue;
    geactiveerd++;
    await supabase.from('vault_changelog').insert({
      entity: 'heuristic',
      entity_key: String(h.rule).slice(0, 120),
      field: 'status',
      old_value: 'candidate',
      new_value: 'active',
      reason: a.reden,
      evidence: { heuristic_id: a.id },
      agent_run_id: agentRunId,
      decided_by: decidedBy,
    });
  }

  await supabase
    .from('agent_runs')
    .update({ status: 'approved', decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq('id', agentRunId);

  return { applied: proposal.wijzigingen.length, geactiveerd };
}

export async function rejectRetroProposal(agentRunId: string, decidedBy: string) {
  const { error } = await db()
    .from('agent_runs')
    .update({ status: 'rejected', decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq('id', agentRunId);
  if (error) throw error;
}
