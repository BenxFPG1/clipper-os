import { z } from 'zod';

export const SCHEMA_VERSION = '1.0';
export const PROMPT_VERSION_CHARACTER_MAP = 'charmap-3.1';
export const PROMPT_VERSION_PLAN = 'plan-4.0';

// ------------------------------------------------------- stap 1: character map
export const sleutelmomentSchema = z.object({
  start: z.number(),
  end: z.number(),
  wat: z.string(),
  functie: z.enum(['setup', 'escalatie', 'barst', 'payoff', 'button']),
});

export const persoonSchema = z.object({
  naam: z.string(),
  rol: z.string(),
  boog: z.string(),
  sleutelmomenten: z.array(sleutelmomentSchema).min(1),
  ironie: z.string(),
});

/**
 * Verhaalwaardige momenten uit gespreksmateriaal (podcasts, interviews):
 * het letterlijke citaat is verplicht, want dat citaat wordt later de hook of
 * de payoff van een clip — een parafrase is daar onbruikbaar voor.
 */
export const vondstSchema = z.object({
  soort: z.enum(['claim', 'anekdote', 'bekentenis', 'botsing', 'getal', 'ontweken_vraag', 'callback']),
  start: z.number(),
  end: z.number(),
  citaat: z.string().min(10),
  waarom: z.string(),
});

/**
 * Audio-gemeten momenten (bouwsteen A): stiltes, volumepieken en
 * tempowisselingen. Puur meetkundig, geen oordeel — de analist gebruikt ze om
 * vondsten te onderbouwen of te vinden die in de tekst alleen niet opvallen.
 */
export const energiemomentSchema = z.object({
  soort: z.enum(['stilte', 'volumepiek', 'tempowisseling']),
  start: z.number(),
  end: z.number(),
  sterkte: z.number().min(0).max(1),
});
export type Energiemoment = z.infer<typeof energiemomentSchema>;

export const characterMapSchema = z.object({
  personen: z.array(persoonSchema).min(1),
  // Verplicht (niet .optional()): bij een optioneel veld liet het model het
  // in de praktijk soms gewoon helemaal weg in plaats van leeg te laten.
  // Verplicht in het schema dwingt de tool-call het mee te leveren.
  vondsten: z.array(vondstSchema),
  spanningslijnen: z.array(
    z.object({
      beschrijving: z.string(),
      momenten: z.array(z.number()),
    }),
  ),
  reveals: z.array(
    z.object({
      start: z.number(),
      wat: z.string(),
      herinterpreteert: z.array(z.number()),
    }),
  ),
});

export type CharacterMap = z.infer<typeof characterMapSchema>;

// ---------------------------------------------------------- stap 2: clip-plan
export const shotSchema = z.object({
  volgorde: z.number().int().min(1),
  start: z.number(),
  end: z.number(),
  functie: z.enum(['hook', 'setup', 'escalatie', 'barst', 'payoff', 'button']),
  transcript_fragment: z.string(),
  edit_notitie: z.string(),
  // Optioneel: oudere plannen hebben deze velden niet en moeten blijven werken.
  sfx: z.string().optional(),
  beeld_effect: z.string().optional(),
  effect_waarom: z.string().optional(),
  focus: z.enum(['links', 'midden', 'rechts']).optional(),
  /**
   * De emotiecurve (bouwsteen D): 1 = rustige opbouw, 10 = climax/payoff.
   * Moet oplopen naar de payoff toe, niet vlak blijven. De montage gebruikt
   * dit om muziek en effecten mee te laten bewegen; optioneel zodat oudere
   * plannen zonder dit veld exact hetzelfde blijven renderen.
   */
  spanning: z.number().min(1).max(10).optional(),
});

export const clipSchema = z.object({
  titel_intern: z.string(),
  structure_type: z.string(),
  prioriteit: z.number().int().min(1),
  verwachte_sterkte: z.enum(['hoog', 'midden', 'vulling']),
  /**
   * Het toernooi (bouwsteen B): in het concept een eigen voorlopige
   * inschatting, in het examen het definitieve, hard onderbouwde oordeel
   * waarop genadeloos gesnoeid wordt. 1-10.
   */
  score: z.number().min(1).max(10).optional(),
  /**
   * De verhaallijn vóór de shots — dezelfde discipline die de scriptwriter
   * beter maakte. Zonder expliciete belofte, open vraag, escalatie en payoff
   * is een clip een fragment, geen verhaal; het schema dwingt af dat de
   * planner dit eerst bouwt en er dan pas shots bij zoekt.
   */
  verhaallijn: z.object({
    belofte: z.string().min(10),
    open_vraag: z.string().min(10),
    escalatie: z.array(z.string()).min(2),
    payoff: z.string().min(10),
  }),
  hook: z.object({
    type: z.string(),
    tekst_overlay: z.string(),
    gesproken_start: z.string(),
  }),
  /**
   * Drie hooks per verhaallijn: de gekozen winnaar (identiek aan "hook")
   * plus twee volwaardige alternatieven uit ándere formules. Elke hook is
   * meteen een publiceerbare variant van dezelfde clip — drie kansen op
   * dezelfde montage.
   */
  hooks: z
    .array(
      z.object({
        type: z.string(),
        tekst_overlay: z.string(),
        gesproken_start: z.string(),
        waarom: z.string(),
      }),
    )
    .min(3),
  /** Uit de retentie-simulatie van het examen: waar swipet iemand weg, en wat is daaraan gedaan. */
  uitval_risicos: z
    .array(z.object({ seconde: z.number(), waarom: z.string(), fix: z.string() }))
    .optional(),
  context_kaart: z.string().nullable(),
  shots: z.array(shotSchema).min(1),
  caption: z.object({
    tiktok: z.string(),
    reels: z.string(),
    shorts: z.string(),
  }),
  verplichte_elementen: z.array(z.string()),
  varianten: z
    .array(
      z.object({
        aanpak: z.enum(['reverse_hook', 'kort_skelet', 'ander_anker', 'part1_part2']),
        hook_tekst: z.string(),
        wijziging: z.string(),
      }),
    )
    .min(2),
  risico: z.enum(['geen', 'check_regels']),
  waarom_dit_werkt: z.string(),
  muziek: z.string().optional(),
  kader: z.enum(['staand', 'vullend', 'blur', 'origineel']).optional(),
});

export const clipPlanSchema = z.object({
  clips: z.array(clipSchema).min(1),
});

export type Clip = z.infer<typeof clipSchema>;
export type ClipPlan = z.infer<typeof clipPlanSchema>;
