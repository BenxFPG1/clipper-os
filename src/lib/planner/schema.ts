import { z } from 'zod';

export const SCHEMA_VERSION = '1.0';
export const PROMPT_VERSION_CHARACTER_MAP = 'charmap-1.0';
export const PROMPT_VERSION_PLAN = 'plan-2.0';

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

export const characterMapSchema = z.object({
  personen: z.array(persoonSchema).min(1),
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
});

export const clipSchema = z.object({
  titel_intern: z.string(),
  structure_type: z.string(),
  prioriteit: z.number().int().min(1),
  verwachte_sterkte: z.enum(['hoog', 'midden', 'vulling']),
  hook: z.object({
    type: z.string(),
    tekst_overlay: z.string(),
    gesproken_start: z.string(),
  }),
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
});

export const clipPlanSchema = z.object({
  clips: z.array(clipSchema).min(1),
});

export type Clip = z.infer<typeof clipSchema>;
export type ClipPlan = z.infer<typeof clipPlanSchema>;
