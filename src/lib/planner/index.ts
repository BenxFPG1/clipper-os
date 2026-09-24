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
  VerhaaldokterDiff,
  characterMapSchema,
  examenPlanSchema,
  schetsPlanSchema,
  verhaaldokterDiffSchema,
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
  const bijgeleerd = await geleerdeKennis('planner');

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
  // precies díe volledig uit (hooks, captions, varianten). Geen try/catch —
  // de schets alleen is niet publiceerbaar (mist die rijkdom), dus een
  // mislukking hier is een échte mislukking, geen degradatie.
  //
  // Mét het brontranscript rond de shots van elke kandidaat: de examinator
  // moet instappunten kiezen, dode seconden schrappen en zinnen heel houden,
  // en dat kon hij tot nu toe alleen op de schets — zonder de tekst zelf was
  // elke shotcorrectie giswerk. Niet de hele video (die zat al in de schets);
  // alleen de vensters rond de shots.
  const transcriptPerKandidaat = schets.clips
    .map((clip, i) => `--- kandidaat ${i + 1}: ${clip.titel_intern} ---\n${transcriptRondShots(clip.shots, input.transcript)}`)
    .join('\n\n');

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
${JSON.stringify(schets)}

=== BRONTRANSCRIPT ROND DE SHOTS PER KANDIDAAT (formaat [start-end] tekst; hier moeten fragmenten en instappunten letterlijk in staan) ===
${transcriptPerKandidaat}`,
    schema: examenPlanSchema,
    toolName: 'lever_clip_plan',
    toolDescription: 'Lever het gesnoeide en uitgewerkte clip-plan.',
    maxTokens: 64000,
    effort: PLAN_EXAMEN_EFFORT,
    operation: 'clip_plan_examen',
  });

  // De verhaaldokter: een derde, losse pas die alleen nog toetst of de
  // overgebleven clips echte verhalen zijn (een omslag, stakes) in plaats van
  // keurig ingevulde sjablonen. Krijgt een mechanisch signalenrapport en, per
  // clip, het echte transcript rond de shots — zodat een omslag geverifieerd
  // wordt tegen de bron, niet tegen wat het plan zelf beweert.
  //
  // Hij krijgt alleen wat hij mag aanraken (titel, verhaallijn, score,
  // transcript) en levert alleen dat terug; de samenvoeging gebeurt hier.
  // Shots, hooks en captions kán hij zo niet meer per ongeluk herschrijven,
  // en de call is een fractie van de vorige (die het hele plan heen én terug
  // stuurde).
  let doctored = examined;
  try {
    const signalenRapport = rapportVoorPrompt(keurVerhaaldokter(examined));
    const perClip = examined.clips.map((clip, i) => ({
      clip: i + 1,
      titel: clip.titel_intern,
      score: clip.score,
      verhaallijn: clip.verhaallijn,
      transcript: transcriptRondShots(clip.shots, input.transcript),
    }));

    const diff: VerhaaldokterDiff = await structuredCall({
      system: VERHAALDOKTER_SYSTEM + bijgeleerd,
      user: `Video: ${input.title}

=== CHARACTER MAP (met "reveals" — herinterpretaties die de payoff kan gebruiken) ===
${JSON.stringify(input.characterMap)}

=== CLIPS (na het toernooi; per clip de verhaallijn, de score en het brontranscript rond de shots) ===
${JSON.stringify(perClip, null, 1)}${signalenRapport}`,
      schema: verhaaldokterDiffSchema,
      toolName: 'lever_verhaaldokter_oordeel',
      toolDescription: 'Lever per clip het oordeel van de verhaaldokter: verwijderen, score en eventueel de herschreven verhaallijn.',
      maxTokens: 16000,
      effort: PLAN_VERHAALDOKTER_EFFORT,
      operation: 'clip_plan_verhaaldokter',
    });
    doctored = pasVerhaaldokterToe(examined, diff);
  } catch (err) {
    console.warn('[planner] verhaaldokter-pass mislukt, geëxamineerd plan behouden:', (err as Error).message);
  }

  return repairPlan(doctored, input);
}

/**
 * Voegt het oordeel van de verhaaldokter samen met het geëxamineerde plan.
 * Alleen verhaallijn, score en de clipselectie veranderen; al het andere
 * blijft byte voor byte staan. Wil hij álles verwijderen, dan blijft het plan
 * zoals het was — een leeg plan is nooit de bedoeling van een verfijningspas.
 */
export function pasVerhaaldokterToe(plan: ClipPlan, diff: VerhaaldokterDiff): ClipPlan {
  const perClip = new Map(diff.clips.map((d) => [d.clip, d]));
  const clips = plan.clips
    .map((clip, i) => {
      const d = perClip.get(i + 1);
      if (!d) return clip;
      if (d.verwijderen) return null;
      return { ...clip, score: d.score, verhaallijn: d.verhaallijn ?? clip.verhaallijn };
    })
    .filter((c): c is Clip => c !== null);
  if (clips.length === 0) {
    console.warn('[planner] verhaaldokter wilde elke clip verwijderen; plan ongewijzigd gelaten');
    return plan;
  }
  return { clips };
}

/**
 * Het stuk brontranscript rond een set shots, met een kleine marge — niet
 * het min/max-tijdvenster van de hele clip (die kan tientallen minuten
 * beslaan bij een cold open of callback), maar de vensters rond elk shot
 * apart. Dat geeft de examinator en de verhaaldokter precies genoeg context
 * om een citaat, instappunt of omslag te verifiëren, zonder de hele video
 * opnieuw mee te sturen.
 */
export function transcriptRondShots(
  shots: { start: number; end: number }[],
  transcript: TranscriptSegment[],
  margeSeconden = 20,
): string {
  const vensters = shots.map((s) => ({ van: Math.max(0, s.start - margeSeconden), tot: s.end + margeSeconden }));
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
