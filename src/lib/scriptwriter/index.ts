import { z } from 'zod';
import { structuredCall } from '../claude';
import { SCRIPT_EFFORT } from '../env';
import { db } from '../supabase';
import { loadVault, renderVaultForPrompt } from '../vault';

export const SCRIPT_SCHEMA_VERSION = '1.0';
export const SCRIPT_PROMPT_VERSION = 'script-1.0';

export const scriptSchema = z.object({
  concept: z.string(),
  structure_type: z.string(),
  hook: z.object({
    type: z.string(),
    tekst_overlay: z.string(),
    gesproken: z.string(),
    waarom: z.string(),
  }),
  shotlist: z
    .array(
      z.object({
        volgorde: z.number().int().min(1),
        seconde_van: z.number(),
        seconde_tot: z.number(),
        functie: z.enum(['hook', 'setup', 'escalatie', 'barst', 'payoff', 'button']),
        beeld: z.string(),
        gesproken_tekst: z.string(),
        tekst_in_beeld: z.string().nullable(),
        edit_notitie: z.string(),
      }),
    )
    .min(3),
  caption: z.object({ tiktok: z.string(), reels: z.string(), shorts: z.string() }),
  hashtags: z.array(z.string()),
  benodigdheden: z.array(z.string()),
  varianten: z
    .array(z.object({ aanpak: z.string(), hook_tekst: z.string(), wijziging: z.string() }))
    .min(2),
  risico: z.enum(['geen', 'check_regels']),
  onderbouwing: z.string(),
});

export type Script = z.infer<typeof scriptSchema>;

const SCRIPT_SYSTEM = `Je bent scriptschrijver voor short-form video (TikTok, Reels, Shorts). Je krijgt een briefing en je levert een volledig, opneembaar script.

Je schrijft NIET vanuit je eigen smaak maar vanuit de kennis in de meegeleverde vault: die structuren en hooks zijn gewogen op basis van gemeten resultaten van dit team. Een hoger gewicht betekent aantoonbaar beter presteren. Kies de structuur en hook die bij de briefing passen én een hoog gewicht hebben, en leg in "onderbouwing" uit waarom juist die combinatie — met verwijzing naar de gewichten en, als ze meegeleverd zijn, de vondsten van andere accounts.

Regels voor het script:
- Beat 1 is de hook in de eerste 0 tot 1,5 seconde: beweging in beeld, audio start mid-zin, tekst-overlay met de spanning. Geen aanloop, geen begroeting, geen logo.
- Daarna context (maximaal één regel), escalatie, en een payoff die de belofte van de hook inlost.
- De shotlist is per shot uitvoerbaar: wat zie je, wat wordt er gezegd, wat staat er in beeld, en wat moet de editor doen.
- De tijdcodes in seconde_van en seconde_tot zijn posities binnen de nieuwe video en lopen op.
- Captions zijn vragen, geen beschrijvingen.
- Respecteer de campagneregels als die meegeleverd zijn; zet risico op "check_regels" als iets op het randje zit.
- Lever 2 tot 3 varianten: een ander instappunt met een andere hook, nooit dezelfde video met andere tekst.
- In "benodigdheden" zet je wat er nodig is om dit te maken (locatie, props, schermopnames, stockbeelden, voice-over).`;

export type BriefInput = {
  titel: string;
  briefing: string;
  doel: string | null;
  platform: string | null;
  duurSeconden: number | null;
  theme: string | null;
  campaignRules: unknown;
};

/**
 * Schrijft een script voor een briefing. Gebruikt dezelfde vault als de
 * clip-planner, plus de best presterende vondsten van de Scout-agent, zodat de
 * opgebouwde kennis ook geldt voor materiaal dat we zelf maken.
 */
export async function generateScript(brief: BriefInput): Promise<{ script: Script; vaultSnapshot: unknown }> {
  const vault = await loadVault({ platform: brief.platform, theme: brief.theme });

  // Vondsten uit hetzelfde thema eerst; die zeggen het meest over deze briefing.
  let findsQuery = db()
    .from('scout_finds')
    .select('handle, platform, theme, post_url, outlier_score, caption, decoded')
    .not('decoded', 'is', null);
  if (brief.theme) findsQuery = findsQuery.eq('theme', brief.theme);
  const { data: finds } = await findsQuery
    .order('outlier_score', { ascending: false, nullsFirst: false })
    .limit(10);

  const scoutBlok =
    finds && finds.length > 0
      ? `\n=== WAT BIJ ANDERE ACCOUNTS WERKT (Scout-agent) ===\n${JSON.stringify(finds, null, 2)}`
      : '';

  const script = await structuredCall({
    system: SCRIPT_SYSTEM,
    user: `=== BRIEFING ===
Titel: ${brief.titel}
Platform: ${brief.platform ?? 'nog niet bepaald'}
Beoogde duur: ${brief.duurSeconden ? `${brief.duurSeconden} seconden` : 'niet opgegeven'}
Doel: ${brief.doel ?? 'niet opgegeven'}

${brief.briefing}

=== CAMPAGNEREGELS ===
${JSON.stringify(brief.campaignRules ?? {}, null, 2)}

=== VAULT (onze gemeten kennis) ===
${renderVaultForPrompt(vault)}${scoutBlok}`,
    schema: scriptSchema,
    toolName: 'lever_script',
    toolDescription: 'Lever het volledige script voor deze briefing.',
    maxTokens: 32000,
    effort: SCRIPT_EFFORT,
    operation: 'scriptwriter',
  });

  return { script, vaultSnapshot: vault };
}

/** Genereert een script voor een opgeslagen briefing en bewaart het als nieuwe versie. */
export async function runScriptwriterForBrief(briefId: string) {
  const supabase = db();

  const { data: brief, error } = await supabase
    .from('briefs')
    .select('*, campaigns(platform_rules, theme)')
    .eq('id', briefId)
    .single();
  if (error) throw error;

  const { script, vaultSnapshot } = await generateScript({
    titel: brief.titel,
    briefing: brief.briefing,
    doel: brief.doel,
    platform: brief.platform,
    duurSeconden: brief.duur_seconden,
    theme: brief.theme ?? (brief.campaigns as { theme?: string | null } | null)?.theme ?? null,
    campaignRules: (brief.campaigns as { platform_rules?: unknown } | null)?.platform_rules ?? {},
  });

  const { data: row, error: insertError } = await supabase
    .from('brief_scripts')
    .insert({
      brief_id: briefId,
      prompt_version: SCRIPT_PROMPT_VERSION,
      schema_version: SCRIPT_SCHEMA_VERSION,
      vault_snapshot: vaultSnapshot,
      script,
    })
    .select()
    .single();
  if (insertError) throw insertError;

  return { scriptId: row.id, script };
}
