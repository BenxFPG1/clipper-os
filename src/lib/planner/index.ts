import { structuredCall } from '../claude';
import { CHARMAP_EFFORT, PLAN_EFFORT, PLAN_EXAMEN_EFFORT, PLAN_VERHAALDOKTER_EFFORT, PLAN_MAX_CLIPS } from '../env';
import { geleerdeKennis } from '../vault/kennis';
import { TranscriptSegment, renderTranscript, transcriptDuration } from '../ingest/transcript';
import { VaultSnapshot, renderVaultForPrompt } from '../vault';
import {
  CHARACTER_MAP_SYSTEM,
  VERHAALDOKTER_SYSTEM,
  buildCharacterMapUser,
  buildSchetsUser,
  planExamenSystem,
  schetsSystem,
} from './prompts';
import { keurVerhaaldokter, rapportVoorPrompt } from './verhaaldokterpoort';
import {
  CharacterMap,
  Clip,
  ClipPlan,
  PROMPT_VERSION_CHARACTER_MAP,
  PROMPT_VERSION_PLAN,
  SchetsPlan,
  characterMapSchema,
  clipPlanSchema,
  schetsPlanSchema,
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
  energieText?: string;
}): Promise<CharacterMap> {
  return structuredCall({
    system: CHARACTER_MAP_SYSTEM,
    user: buildCharacterMapUser({
      title: input.title,
      durationSeconds: input.durationSeconds,
      transcript: renderTranscript(input.transcript),
      energie: input.energieText,
    }),
    schema: characterMapSchema,
    toolName: 'lever_character_map',
    toolDescription: 'Lever de narratieve analyse van de volledige video.',
    maxTokens: 32000,
    effort: CHARMAP_EFFORT,
    operation: 'character_map',
  });
}

/**
 * Stap 2: bouw het clip-plan op basis van de character map, vault en
 * campagneregels. Drie passen, elk met een eigen taak:
 *
 * 1. Schets (breed, goedkoop) — kandidaat-verhaallijnen zonder rijkdom.
 * 2. Toernooi-examen (snoeien, dán pas uitwerken) — schrijft hooks, effecten,
 *    captions precies één keer, en alleen voor wie de snoeironde overleeft.
 * 3. Verhaaldokter (smal, laatste check) — is dit een echt verhaal?
 *
 * Stap 2 heeft geen fallback: zonder hem is er niets publiceerbaars (de
 * schets mist hooks/captions/effecten), dus een mislukking daar laten we
 * gewoon doorgooien — precies zoals character map dat al deed. Stap 3 is wel
 * puur verfijning op een al volledig plan; faalt die, dan houden we wat er is.
 */
export async function generateClipPlan(
  input: PlannerInput & { characterMap: CharacterMap },
): Promise<ClipPlan> {
  // De zelflerende laag komt achter de vaste kaders aan.
  const bijgeleerd = await geleerdeKennis();

  const schets: SchetsPlan = await structuredCall({
    system: schetsSystem(PLAN_MAX_CLIPS) + bijgeleerd,
    user: buildSchetsUser({
      title: input.title,
      durationSeconds: input.durationSeconds,
      transcript: renderTranscript(input.transcript),
      characterMapJson: JSON.stringify(input.characterMap),
      vaultText: renderVaultForPrompt(input.vault),
      campaignRulesJson: JSON.stringify(input.campaignRules ?? {}, null, 2),
    }),
    schema: schetsPlanSchema,
    toolName: 'lever_schets',
    toolDescription: 'Lever de brede set kandidaat-verhaallijnen voor deze bronvideo.',
    maxTokens: 32000,
    // De schets hoeft niet perfect te zijn, alleen breed — het toernooi
    // snoeit en de uitwerking gebeurt pas voor de overlevers.
    effort: PLAN_EFFORT,
    operation: 'clip_schets',
  });

  // Toernooi-examen: snoeit de schets naar de sterkste kandidaten en werkt
  // precies díe volledig uit (hooks, effecten, captions, varianten). Geen
  // try/catch — de schets alleen is niet publiceerbaar (mist die rijkdom),
  // dus een mislukking hier is een échte mislukking, geen degradatie.
  const examined: ClipPlan = await structuredCall({
    system: planExamenSystem(PLAN_MAX_CLIPS) + bijgeleerd,
    user: `Video: ${input.title}
Duur: ${input.durationSeconds ? `${input.durationSeconds} seconden` : 'onbekend'}

=== CAMPAGNEREGELS ===
${JSON.stringify(input.campaignRules ?? {}, null, 2)}

=== VAULT ===
${renderVaultForPrompt(input.vault)}

=== CHARACTER MAP (de narratieve analyse van de hele video, met tijdcodes) ===
${JSON.stringify(input.characterMap)}

=== SCHETS (de brede kandidatenset; snoei eerst, werk daarna alleen de overlevers uit) ===
${JSON.stringify(schets)}`,
    schema: clipPlanSchema,
    toolName: 'lever_clip_plan',
    toolDescription: 'Lever het volledige, gesnoeide en uitgewerkte clip-plan.',
    maxTokens: 64000,
    effort: PLAN_EXAMEN_EFFORT,
    operation: 'clip_plan_examen',
  });

  // De verhaaldokter: een derde, losse pas die alleen nog toetst of de
  // overgebleven clips echte verhalen zijn (een omslag, stakes) in plaats van
  // keurig ingevulde sjablonen. Krijgt een mechanisch signalenrapport en, per
  // clip, het echte transcript rond de shots — zodat een omslag geverifieerd
  // wordt tegen de bron, niet tegen wat het plan zelf beweert.
  let doctored = examined;
  try {
    const signalenRapport = rapportVoorPrompt(keurVerhaaldokter(examined));
    const transcriptPerClip = examined.clips
      .map((clip, i) => `--- clip ${i + 1}: ${clip.titel_intern} ---\n${transcriptRondClip(clip, input.transcript)}`)
      .join('\n\n');

    doctored = await structuredCall({
      system: VERHAALDOKTER_SYSTEM + bijgeleerd,
      user: `Video: ${input.title}

=== CHARACTER MAP (met "reveals" — herinterpretaties die de payoff kan gebruiken) ===
${JSON.stringify(input.characterMap)}

=== BRONTRANSCRIPT ROND DE SHOTS VAN ELKE CLIP (ter verificatie van citaten en omslagen) ===
${transcriptPerClip}

=== PLAN (na het toernooi; keur alleen "verhaallijn", "score" en welke clips overblijven) ===
${JSON.stringify(examined)}${signalenRapport}`,
      schema: clipPlanSchema,
      toolName: 'lever_clip_plan',
      toolDescription: 'Lever het volledige plan met de verhaaldokter-correcties.',
      maxTokens: 64000,
      effort: PLAN_VERHAALDOKTER_EFFORT,
      operation: 'clip_plan_verhaaldokter',
    });
  } catch (err) {
    console.warn('[planner] verhaaldokter-pass mislukt, geëxamineerd plan behouden:', (err as Error).message);
  }

  return repairPlan(doctored, input);
}

/**
 * Het stuk brontranscript rond de shots van één clip, met een kleine marge —
 * niet het min/max-tijdvenster van de hele clip (die kan tientallen minuten
 * beslaan bij een cold open of callback), maar de vensters rond elk shot
 * apart. Dat geeft de verhaaldokter precies genoeg context om een citaat of
 * een omslag te verifiëren, zonder de hele video opnieuw mee te sturen.
 */
function transcriptRondClip(clip: Clip, transcript: TranscriptSegment[], margeSeconden = 20): string {
  const vensters = clip.shots.map((s) => ({ van: Math.max(0, s.start - margeSeconden), tot: s.end + margeSeconden }));
  const relevant = transcript.filter((seg) => vensters.some((v) => seg.start_seconds < v.tot && seg.end_seconds > v.van));
  return relevant.length > 0 ? renderTranscript(relevant) : '(geen brontranscript gevonden rond deze shots)';
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
      hooks: clip.hooks?.map((h) => ({
        ...h,
        type: hookSlugs.has(h.type) ? h.type : fallbackHook,
      })),
      shots,
    };
  });

  // Het toernooi (bouwsteen B): sorteert op het examenoordeel (score) als dat
  // er is, anders op de oorspronkelijke prioriteit. Prioriteit wordt daarna
  // altijd hernummerd 1..n zodat de dashboardvolgorde klopt, ook als het
  // model gaten of dubbele nummers leverde.
  const gesorteerd = [...clips].sort((a, b) => {
    if (a.score !== undefined && b.score !== undefined && a.score !== b.score) return b.score - a.score;
    return a.prioriteit - b.prioriteit;
  });

  return { clips: gesorteerd.map((clip, i) => ({ ...clip, prioriteit: i + 1 })) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max || value);
}

export const PROMPT_VERSION = `${PROMPT_VERSION_CHARACTER_MAP}+${PROMPT_VERSION_PLAN}`;
