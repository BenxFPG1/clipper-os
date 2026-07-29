import { z } from 'zod';
import { structuredCall } from '../claude';
import { AGENT_EFFORT } from '../env';
import { db, one } from '../supabase';
import { ALL, loadWeights, upsertWeight } from '../vault';
import { median } from '../tracking/performance';

/** Minimum aantal waarnemingen per kant (eigen of extern) om mee te tellen. */
export const MIN_N_PER_GROUP = 5;
export const MAX_WEIGHT_STEP = 0.15;
/**
 * Hoe zwaar eigen resultaten wegen tegenover wat we buiten zien. 0.5 = gelijk:
 * de vault leert net zo hard van werkende content van anderen als van onszelf.
 */
export const EIGEN_GEWICHT = 0.5;

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
  /** Gecombineerde score: 50% eigen, 50% extern (zie EIGEN_GEWICHT). */
  gecombineerde_score: number | null;
  huidig_gewicht: number;
  clip_ids: string[];
  post_urls: string[];
};

const RETRO_SYSTEM = `Je bent de Retro-agent van een clipping-tool. Je krijgt prestatiecijfers per structuur- en hook-type, uitgesplitst naar platform en thema, en de huidige vault-gewichten. Je stelt gewichtswijzigingen voor.

Belangrijk: de cijfers komen uit twee bronnen die even zwaar wegen.
- eigen_mediaan: hoe onze eigen geposte clips presteerden (outlier-score t.o.v. onze mediaan).
- extern_mediaan: hoe dezelfde structuur/hook presteerde bij andere accounts die de scout vond.
De gecombineerde_score is het gewogen gemiddelde van beide. Een score boven 1 is bovengemiddeld, onder 1 ondergemiddeld.

Harde regels:
- Stel alleen een wijziging voor als eigen_n >= ${MIN_N_PER_GROUP} of extern_n >= ${MIN_N_PER_GROUP}. Groepen met minder data laat je ongemoeid.
- De stap is maximaal ${MAX_WEIGHT_STEP} omhoog of omlaag per run.
- Gewichten blijven tussen 0 en 1.
- Elk voorstel geldt voor precies één combinatie van platform en thema; die neem je letterlijk over uit de data.
- Onderbouw met de clip_ids en post_urls uit de groep.
- Wat op het ene platform werkt hoeft op het andere niet te werken; behandel elke combinatie los.
- Steunt een voorstel maar op één bron, zeg dat dan expliciet in de reden.
- Geen duidelijke richting? Dan stel je niets voor; een lege lijst is een geldig antwoord.`;

/**
 * Verzamelt prestaties per (structuur/hook × platform × thema) uit twee bronnen:
 * onze eigen geposte clips én de gedecodeerde vondsten van de scout. Beide
 * tellen even zwaar mee, zodat de vault ook leert van content die wij nooit
 * gemaakt hebben.
 */
export async function collectRetroStats(): Promise<GroupStats[]> {
  const supabase = db();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const [eigenRes, externRes, weights] = await Promise.all([
    supabase
      .from('clips')
      .select('id, structure_type, hook_type, platform, theme, posted_at, clip_performance(outlier_score)')
      .eq('status', 'posted')
      .lte('posted_at', sevenDaysAgo),
    supabase.from('scout_finds').select('post_url, platform, theme, outlier_score, decoded').not('decoded', 'is', null),
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
    // Niet-overdraagbare vondsten zeggen niets over ons werk.
    if (decoded.overdraagbaar_naar_ons === false) continue;

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

  return [...buckets.values()].map((b) => {
    const eigenMediaan = median(b.eigen);
    const externMediaan = median(b.extern);
    return {
      entity: b.entity,
      slug: b.slug,
      platform: b.platform,
      theme: b.theme,
      eigen_n: b.eigen.length,
      eigen_mediaan: eigenMediaan,
      extern_n: b.extern.length,
      extern_mediaan: externMediaan,
      gecombineerde_score: combineer(eigenMediaan, externMediaan),
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
 * Draait de wekelijkse retro en zet het voorstel klaar in de agent-inbox.
 * De agent muteert nooit zelf de vault — Antonie keurt goed (sectie 3, principe 4).
 */
export async function runRetroAgent(): Promise<{ agentRunId: string; proposal: RetroProposal; stats: GroupStats[] }> {
  const stats = await collectRetroStats();
  const eligible = stats.filter((s) => s.eigen_n >= MIN_N_PER_GROUP || s.extern_n >= MIN_N_PER_GROUP);

  const proposal: RetroProposal =
    eligible.length === 0
      ? {
          wijzigingen: [],
          samenvatting: `Geen enkele groep haalt de drempel van ${MIN_N_PER_GROUP} waarnemingen (eigen clips of externe vondsten). Nog geen voorstel.`,
        }
      : enforceRules(
          await structuredCall({
            system: RETRO_SYSTEM,
            user: `Groepen die de drempel halen:\n${JSON.stringify(eligible, null, 2)}\n\nAlle gemeten groepen ter context:\n${JSON.stringify(stats, null, 2)}`,
            schema: proposalSchema,
            toolName: 'lever_vault_voorstel',
            toolDescription: 'Lever de voorgestelde vault-gewichtswijzigingen met bewijs.',
            maxTokens: 16000,
            effort: AGENT_EFFORT,
            operation: 'retro_agent',
          }),
          eligible,
        );

  const { data, error } = await db()
    .from('agent_runs')
    .insert({
      agent: 'retro',
      input_summary: { groepen: stats.length, in_aanmerking: eligible.length, stats },
      proposal,
      // Een run zonder wijzigingen vraagt niets van je; die hoort in de historie,
      // niet in de inbox. Anders staat er elke week een leeg voorstel te wachten.
      status: proposal.wijzigingen.length > 0 ? 'pending' : 'auto',
    })
    .select()
    .single();
  if (error) throw error;

  return { agentRunId: data.id, proposal, stats };
}

/**
 * De regels uit sectie 10 worden in code afgedwongen, niet alleen in de prompt:
 * onvoldoende data of een te grote stap wordt hier gecorrigeerd of geweigerd.
 */
function enforceRules(proposal: RetroProposal, eligible: GroupStats[]): RetroProposal {
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

  return { ...proposal, wijzigingen };
}

/** Voert een goedgekeurd voorstel uit: gewicht bijwerken, version bumpen, changelog schrijven. */
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

  await supabase
    .from('agent_runs')
    .update({ status: 'approved', decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq('id', agentRunId);

  return { applied: proposal.wijzigingen.length };
}

export async function rejectRetroProposal(agentRunId: string, decidedBy: string) {
  const { error } = await db()
    .from('agent_runs')
    .update({ status: 'rejected', decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq('id', agentRunId);
  if (error) throw error;
}
