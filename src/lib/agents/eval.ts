import { db } from '../supabase';
import { TranscriptSegment, transcriptDuration } from '../ingest/transcript';
import { generateCharacterMap, generateClipPlan, PROMPT_VERSION } from '../planner';
import { loadVault } from '../vault';
import { ClipPlan } from '../planner/schema';

export type ExpectedProperties = {
  min_clips?: number;
  /** Momenten die gevonden moeten worden, met tolerantie in seconden. */
  gouden_momenten?: { naam: string; seconde: number; tolerantie_seconden?: number }[];
  /** Minstens één clip moet fragmenten combineren die zo ver uit elkaar liggen. */
  min_fragment_afstand_seconden?: number;
};

export type CheckResult = { check: string; passed: boolean; detail: string };

export type EvalCaseResult = {
  case_id: string;
  name: string;
  passed: boolean;
  checks: CheckResult[];
};

/**
 * Draait alle eval-cases door de volledige planner-pipeline. Wordt gebruikt als
 * poort voor prompt- en vault-wijzigingen: faalt één case, dan gaat de wijziging
 * niet live (sectie 13, kwaliteitsdrift).
 */
export async function runEvalAgent(): Promise<{ passed: boolean; results: EvalCaseResult[]; evalRunId: string }> {
  const supabase = db();
  const { data: cases, error } = await supabase.from('eval_cases').select('*');
  if (error) throw error;

  const vault = await loadVault();
  const results: EvalCaseResult[] = [];

  for (const evalCase of cases ?? []) {
    const transcript = evalCase.input_transcript as TranscriptSegment[];
    const duration = evalCase.duration_seconds ?? Math.round(transcriptDuration(transcript));
    const expected = (evalCase.expected_properties ?? {}) as ExpectedProperties;

    try {
      const characterMap = await generateCharacterMap({
        title: evalCase.name,
        durationSeconds: duration,
        transcript,
      });
      const plan = await generateClipPlan({
        title: evalCase.name,
        durationSeconds: duration,
        transcript,
        campaignRules: evalCase.campaign_rules ?? {},
        vault,
        characterMap,
      });

      const checks = checkPlan(plan, expected, duration, vault.structures.map((s) => s.slug), vault.hooks.map((h) => h.slug));
      results.push({
        case_id: evalCase.id,
        name: evalCase.name,
        passed: checks.every((c) => c.passed),
        checks,
      });
    } catch (e) {
      results.push({
        case_id: evalCase.id,
        name: evalCase.name,
        passed: false,
        checks: [{ check: 'pipeline', passed: false, detail: e instanceof Error ? e.message : String(e) }],
      });
    }
  }

  const passed = results.length > 0 && results.every((r) => r.passed);

  const { data: run, error: runError } = await supabase
    .from('eval_runs')
    .insert({ prompt_version: PROMPT_VERSION, passed, results })
    .select()
    .single();
  if (runError) throw runError;

  return { passed, results, evalRunId: run.id };
}

/** De checks uit sectie 10: structuur, tijdcodes, aantal clips, gouden momenten, spreiding. */
export function checkPlan(
  plan: ClipPlan,
  expected: ExpectedProperties,
  durationSeconds: number,
  structureSlugs: string[],
  hookSlugs: string[],
): CheckResult[] {
  const checks: CheckResult[] = [];
  const minClips = expected.min_clips ?? 10;

  checks.push({
    check: 'min_clips',
    passed: plan.clips.length >= minClips,
    detail: `${plan.clips.length} clips (minimaal ${minClips})`,
  });

  const badTimecodes = plan.clips.filter((clip) =>
    clip.shots.some(
      (shot, i) =>
        shot.start < 0 ||
        shot.end > durationSeconds ||
        shot.end < shot.start ||
        (i > 0 && shot.volgorde <= clip.shots[i - 1].volgorde),
    ),
  );
  checks.push({
    check: 'tijdcodes',
    passed: badTimecodes.length === 0,
    detail:
      badTimecodes.length === 0
        ? `Alle tijdcodes binnen 0-${durationSeconds}s en oplopend`
        : `Fout in: ${badTimecodes.map((c) => c.titel_intern).join(', ')}`,
  });

  const structures = new Set(structureSlugs);
  const hooks = new Set(hookSlugs);
  const badSlugs = plan.clips.filter(
    (c) => !structures.has(c.structure_type) || !hooks.has(c.hook.type),
  );
  checks.push({
    check: 'vault_slugs',
    passed: badSlugs.length === 0,
    detail: badSlugs.length === 0 ? 'Alle slugs bestaan in de vault' : `Onbekend in: ${badSlugs.map((c) => c.titel_intern).join(', ')}`,
  });

  for (const moment of expected.gouden_momenten ?? []) {
    const tolerance = moment.tolerantie_seconden ?? 90;
    const found = plan.clips.some((clip) =>
      clip.shots.some(
        (shot) => shot.start <= moment.seconde + tolerance && shot.end >= moment.seconde - tolerance,
      ),
    );
    checks.push({
      check: `gouden_moment:${moment.naam}`,
      passed: found,
      detail: found
        ? `Gevonden rond ${moment.seconde}s`
        : `Niet gevonden rond ${moment.seconde}s (±${tolerance}s)`,
    });
  }

  if (expected.min_fragment_afstand_seconden) {
    const required = expected.min_fragment_afstand_seconden;
    const spread = plan.clips
      .map((clip) => {
        const starts = clip.shots.map((s) => s.start);
        return Math.max(...starts) - Math.min(...starts);
      })
      .reduce((max, v) => Math.max(max, v), 0);
    checks.push({
      check: 'fragment_afstand',
      passed: spread >= required,
      detail: `Grootste spreiding binnen één clip: ${Math.round(spread)}s (minimaal ${required}s)`,
    });
  }

  return checks;
}
