import { z } from 'zod';
import { structuredCall } from '../claude';
import { db, one } from '../supabase';
import { loadVault } from '../vault';
import { median } from '../tracking/performance';

export const MIN_N_PER_GROUP = 5;
export const MAX_WEIGHT_STEP = 0.15;

const proposalSchema = z.object({
  wijzigingen: z.array(
    z.object({
      entity: z.enum(['structure', 'hook']),
      slug: z.string(),
      huidig_gewicht: z.number(),
      nieuw_gewicht: z.number(),
      reden: z.string(),
      bewijs_clip_ids: z.array(z.string()),
    }),
  ),
  samenvatting: z.string(),
});

export type RetroProposal = z.infer<typeof proposalSchema>;

type GroupStats = {
  entity: 'structure' | 'hook';
  slug: string;
  n: number;
  mediaan_outlier_score: number | null;
  huidig_gewicht: number;
  clip_ids: string[];
};

const RETRO_SYSTEM = `Je bent de Retro-agent van een clipping-tool. Je krijgt performance-data per structuur- en hook-type en de huidige vault-gewichten. Je stelt gewichtswijzigingen voor.

Harde regels:
- Stel alleen een wijziging voor bij n >= ${MIN_N_PER_GROUP} clips in die groep. Groepen met minder data laat je ongemoeid.
- De stap per week is maximaal ${MAX_WEIGHT_STEP} omhoog of omlaag.
- Gewichten blijven tussen 0 en 1.
- Elk voorstel onderbouw je met de clip_ids uit de groep en de gemeten mediaan.
- Een mediaan outlier_score boven 1 betekent bovengemiddeld, onder 1 ondergemiddeld.
- Stel niets voor als de data geen duidelijke richting geeft; een lege lijst is een geldig antwoord.`;

/** Verzamelt performance per structuur en hook over clips met minstens 7 dagen data. */
export async function collectRetroStats(): Promise<GroupStats[]> {
  const supabase = db();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const { data, error } = await supabase
    .from('clips')
    .select('id, structure_type, hook_type, posted_at, clip_performance(outlier_score)')
    .eq('status', 'posted')
    .lte('posted_at', sevenDaysAgo);
  if (error) throw error;

  const vault = await loadVault();
  const structureWeights = new Map(vault.structures.map((s) => [s.slug, s.weight]));
  const hookWeights = new Map(vault.hooks.map((h) => [h.slug, h.weight]));

  type Bucket = { entity: 'structure' | 'hook'; slug: string; scores: number[]; ids: string[] };
  const buckets = new Map<string, Bucket>();

  for (const clip of data ?? []) {
    const perf = one<{ outlier_score: number | null }>(clip.clip_performance);
    if (!perf?.outlier_score && perf?.outlier_score !== 0) continue;

    for (const [entity, slug] of [
      ['structure', clip.structure_type],
      ['hook', clip.hook_type],
    ] as const) {
      if (!slug) continue;
      const key = `${entity}:${slug}`;
      const bucket: Bucket = buckets.get(key) ?? { entity, slug, scores: [], ids: [] };
      bucket.scores.push(Number(perf.outlier_score));
      bucket.ids.push(clip.id as string);
      buckets.set(key, bucket);
    }
  }

  return [...buckets.values()].map((b) => ({
    entity: b.entity,
    slug: b.slug,
    n: b.scores.length,
    mediaan_outlier_score: median(b.scores),
    huidig_gewicht: (b.entity === 'structure' ? structureWeights.get(b.slug) : hookWeights.get(b.slug)) ?? 0.5,
    clip_ids: b.ids,
  }));
}

/**
 * Draait de wekelijkse retro en zet het voorstel klaar in de agent-inbox.
 * De agent muteert nooit zelf de vault — Antonie keurt goed (sectie 3, principe 4).
 */
export async function runRetroAgent(): Promise<{ agentRunId: string; proposal: RetroProposal; stats: GroupStats[] }> {
  const stats = await collectRetroStats();
  const eligible = stats.filter((s) => s.n >= MIN_N_PER_GROUP);

  const proposal: RetroProposal =
    eligible.length === 0
      ? {
          wijzigingen: [],
          samenvatting: `Geen enkele groep haalt de drempel van ${MIN_N_PER_GROUP} clips met 7 dagen data. Nog geen voorstel.`,
        }
      : enforceRules(
          await structuredCall({
            system: RETRO_SYSTEM,
            user: `Performance per groep (alleen groepen die de drempel halen):\n${JSON.stringify(eligible, null, 2)}\n\nAlle gemeten groepen ter context:\n${JSON.stringify(stats, null, 2)}`,
            schema: proposalSchema,
            toolName: 'lever_vault_voorstel',
            toolDescription: 'Lever de voorgestelde vault-gewichtswijzigingen met bewijs.',
            maxTokens: 8000,
            temperature: 0.3,
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
      status: 'pending',
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
  const byKey = new Map(eligible.map((s) => [`${s.entity}:${s.slug}`, s]));

  const wijzigingen = proposal.wijzigingen
    .map((w) => {
      const stat = byKey.get(`${w.entity}:${w.slug}`);
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

  for (const w of proposal.wijzigingen) {
    const table = w.entity === 'structure' ? 'vault_structures' : 'vault_hooks';
    const { data: current, error: readError } = await supabase
      .from(table)
      .select('weight, version, evidence')
      .eq('slug', w.slug)
      .single();
    if (readError) throw readError;

    const { error: updateError } = await supabase
      .from(table)
      .update({
        weight: w.nieuw_gewicht,
        version: current.version + 1,
        evidence: { clip_ids: w.bewijs_clip_ids, reden: w.reden, agent_run_id: agentRunId },
        updated_at: new Date().toISOString(),
      })
      .eq('slug', w.slug);
    if (updateError) throw updateError;

    await supabase.from('vault_changelog').insert({
      entity: w.entity,
      entity_key: w.slug,
      field: 'weight',
      old_value: current.weight,
      new_value: w.nieuw_gewicht,
      reason: w.reden,
      evidence: { clip_ids: w.bewijs_clip_ids },
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
