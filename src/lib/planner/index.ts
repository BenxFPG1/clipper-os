import { structuredCall } from '../claude';
import { CHARMAP_EFFORT, PLAN_EFFORT, PLAN_MAX_CLIPS } from '../env';
import { TranscriptSegment, renderTranscript, transcriptDuration } from '../ingest/transcript';
import { VaultSnapshot, renderVaultForPrompt } from '../vault';
import {
  CHARACTER_MAP_SYSTEM,
  buildCharacterMapUser,
  buildPlanUser,
  planExamenSystem,
  planSystem,
} from './prompts';
import {
  CharacterMap,
  ClipPlan,
  PROMPT_VERSION_CHARACTER_MAP,
  PROMPT_VERSION_PLAN,
  characterMapSchema,
  clipPlanSchema,
} from './schema';

export type PlannerInput = {
  title: string;
  durationSeconds: number | null;
  transcript: TranscriptSegment[];
  campaignRules: unknown;
  vault: VaultSnapshot;
};

/** Stap 1: begrijp de hele video als verhaal, niet als losse momenten. */
export async function generateCharacterMap(input: {
  title: string;
  durationSeconds: number | null;
  transcript: TranscriptSegment[];
}): Promise<CharacterMap> {
  return structuredCall({
    system: CHARACTER_MAP_SYSTEM,
    user: buildCharacterMapUser({
      title: input.title,
      durationSeconds: input.durationSeconds,
      transcript: renderTranscript(input.transcript),
    }),
    schema: characterMapSchema,
    toolName: 'lever_character_map',
    toolDescription: 'Lever de narratieve analyse van de volledige video.',
    maxTokens: 32000,
    effort: CHARMAP_EFFORT,
    operation: 'character_map',
  });
}

/** Stap 2: bouw het clip-plan op basis van de character map, vault en campagneregels. */
export async function generateClipPlan(
  input: PlannerInput & { characterMap: CharacterMap },
): Promise<ClipPlan> {
  const plan = await structuredCall({
    system: planSystem(PLAN_MAX_CLIPS),
    user: buildPlanUser({
      title: input.title,
      durationSeconds: input.durationSeconds,
      transcript: renderTranscript(input.transcript),
      characterMapJson: JSON.stringify(input.characterMap),
      vaultText: renderVaultForPrompt(input.vault),
      campaignRulesJson: JSON.stringify(input.campaignRules ?? {}, null, 2),
    }),
    schema: clipPlanSchema,
    toolName: 'lever_clip_plan',
    toolDescription: 'Lever het volledige clip-plan voor deze bronvideo.',
    maxTokens: 64000,
    // Het plan is het inhoudelijke werk: hier loont extra denkwerk het meest.
    effort: PLAN_EFFORT,
    operation: 'clip_plan',
  });

  // Examinatie-pass: het concept langs storycraft, de stijlbibliotheek en het
  // onderzoek. Faalt de pass, dan houden we het concept — nooit niets leveren.
  let examined = plan;
  try {
    examined = await structuredCall({
      system: planExamenSystem(PLAN_MAX_CLIPS),
      user: `${buildPlanUser({
        title: input.title,
        durationSeconds: input.durationSeconds,
        transcript: renderTranscript(input.transcript),
        characterMapJson: JSON.stringify(input.characterMap),
        vaultText: renderVaultForPrompt(input.vault),
        campaignRulesJson: JSON.stringify(input.campaignRules ?? {}, null, 2),
      })}

=== CONCEPTPLAN (te examineren en verbeteren) ===
${JSON.stringify(plan)}`,
      schema: clipPlanSchema,
      toolName: 'lever_clip_plan',
      toolDescription: 'Lever het volledige geëxamineerde en verbeterde clip-plan.',
      maxTokens: 64000,
      effort: PLAN_EFFORT,
      operation: 'clip_plan_examen',
    });
  } catch (err) {
    console.warn('[planner] examinatie-pass mislukt, concept behouden:', (err as Error).message);
  }

  return repairPlan(examined, input);
}

/**
 * Zachte correcties op wat het model structureel fout kan doen: shots in de
 * verkeerde volgorde, tijdcodes buiten de video, of een structure/hook-slug die
 * niet in de vault staat. Onbekende slugs worden op de zwaarst wegende variant
 * gezet in plaats van de clip weg te gooien.
 */
function repairPlan(plan: ClipPlan, input: PlannerInput): ClipPlan {
  const duration = input.durationSeconds ?? transcriptDuration(input.transcript);
  const structureSlugs = new Set(input.vault.structures.map((s) => s.slug));
  const hookSlugs = new Set(input.vault.hooks.map((h) => h.slug));
  const fallbackStructure = input.vault.structures[0]?.slug ?? 'belofte_afstraffing';
  const fallbackHook = input.vault.hooks[0]?.slug ?? 'onthoud_deze_zin';

  const clips = plan.clips.map((clip) => {
    const shots = [...clip.shots]
      .sort((a, b) => a.volgorde - b.volgorde)
      .map((shot, i) => ({
        ...shot,
        volgorde: i + 1,
        start: clamp(Math.min(shot.start, shot.end), 0, duration),
        end: clamp(Math.max(shot.start, shot.end), 0, duration),
      }));

    return {
      ...clip,
      structure_type: structureSlugs.has(clip.structure_type) ? clip.structure_type : fallbackStructure,
      hook: {
        ...clip.hook,
        type: hookSlugs.has(clip.hook.type) ? clip.hook.type : fallbackHook,
      },
      shots,
    };
  });

  return { clips: clips.sort((a, b) => a.prioriteit - b.prioriteit) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max || value);
}

export const PROMPT_VERSION = `${PROMPT_VERSION_CHARACTER_MAP}+${PROMPT_VERSION_PLAN}`;
