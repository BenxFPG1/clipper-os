import { z } from 'zod';
import { structuredCall } from '../claude';
import { SCRIPT_EFFORT, SCRIPT_EXAMEN_EFFORT } from '../env';
import { db } from '../supabase';
import { loadVault, renderVaultForPrompt } from '../vault';
import { STORYCRAFT } from '../vault/storycraft';
import { STORYSTIJLEN } from '../vault/storystijlen';
import { ONDERZOEK } from '../vault/onderzoek';
import { EFFECTEN } from '../vault/effecten';
import { EDITCRAFT } from '../vault/editcraft';
import { geleerdeKennis } from '../vault/kennis';

export const SCRIPT_SCHEMA_VERSION = '1.0';
export const SCRIPT_PROMPT_VERSION = 'script-3.1';

export const scriptSchema = z.object({
  concept: z.string(),
  structure_type: z.string(),
  /**
   * De verhaallijn is verplicht en komt vóór alles: zonder belofte, oplopende
   * spanning en een payoff die de belofte inlost is het geen script maar een
   * opsomming. Het schema dwingt dit af zodat het niet kan wegzakken.
   */
  verhaallijn: z.object({
    belofte: z.string().min(10),
    open_vraag: z.string().min(10),
    escalatie: z.array(z.string()).min(2),
    payoff: z.string().min(10),
    rode_draad: z.string().min(15),
  }),
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
        sfx: z.string().optional(),
        beeld_effect: z.string().optional(),
        effect_waarom: z.string().optional(),
      }),
    )
    .min(3)
    .refine((shots) => shots.some((s) => s.functie === 'payoff'), {
      message: 'De shotlist moet een payoff bevatten; zonder payoff is er geen verhaal.',
    }),
  muziek: z.string().optional(),
  caption: z.object({ tiktok: z.string(), reels: z.string(), shorts: z.string() }),
  hashtags: z.array(z.string()),
  benodigdheden: z.array(z.string()),
  varianten: z
    .array(z.object({ aanpak: z.string(), hook_tekst: z.string(), wijziging: z.string() }))
    .min(2),
  risico: z.enum(['geen', 'check_regels']),
  onderbouwing: z.string(),
  /** Ingevuld door de examinatie-pass: wat de eerste versie mankeerde en wat er is verbeterd. */
  zelfkritiek: z
    .object({
      /** Tegen welke stijl uit de bibliotheek is getoetst, en past die bij de briefing? */
      stijl: z.string(),
      stijl_oordeel: z.string(),
      zwakste_punt: z.string(),
      twijfelachtige_keuzes: z.array(z.object({ keuze: z.string(), oordeel: z.string() })),
      verbeterd: z.array(z.string()),
    })
    .optional(),
});

export type Script = z.infer<typeof scriptSchema>;

const SCRIPT_SYSTEM = `Je bent scriptschrijver voor short-form video (TikTok, Reels, Shorts). Je krijgt een briefing en levert een volledig, opneembaar script.

HET BELANGRIJKSTE: elk script is een mini-verhaal, geen opsomming. Je bouwt hem in deze volgorde:
1. Eerst de verhaallijn: welke belofte doet de hook, welke vraag blijft open tot het einde, in welke stappen loopt de spanning op, en hoe lost de payoff de belofte exact in. Vul dit in het veld "verhaallijn" in VOORDAT je de shotlist schrijft.
2. Dan pas de shotlist, en elk shot moet een taak hebben in dat verhaal: de spanning verhogen of de belofte inlossen. Een shot dat alleen informatie geeft zonder het verhaal vooruit te duwen, schrap je.

Toets jezelf hierop:
- Kun je in één zin zeggen wat de kijker aan het einde weet dat hij aan het begin nog niet wist? Zo niet: geen verhaal.
- Wordt de open vraag pas in de payoff beantwoord? Beantwoord je hem eerder, dan stopt de kijker daar.
- Is de payoff het letterlijke antwoord op de belofte van de hook? Een payoff over iets anders is een gebroken belofte.

Je schrijft NIET vanuit je eigen smaak maar vanuit de meegeleverde vault: die structuren en hooks zijn gewogen op gemeten resultaten. Kies wat past bij de briefing en een hoog gewicht heeft, en verantwoord dat in "onderbouwing".

Ambachtsregels:
- Beat 1 is de hook in de eerste 0 tot 1,5 seconde: beweging in beeld, audio start mid-zin, tekst-overlay met de spanning. Geen aanloop, geen begroeting, geen logo.
- Context maximaal één regel, direct na de hook.
- De shotlist is per shot uitvoerbaar: wat zie je, wat wordt er gezegd, wat staat er in beeld, wat doet de editor.
- Vul per shot "sfx" en "beeld_effect" met een slug uit de effectenvault (of "geen"), plus "effect_waarom": wat de ingreep voor de kijker doet. Vul "muziek" op scriptniveau. Hoogstens twee ingrepen per shot.
- Tijdcodes lopen op binnen de nieuwe video.
- Captions zijn vragen, geen beschrijvingen.
- Respecteer de campagneregels; zet risico op "check_regels" bij twijfel.
- 2 tot 3 varianten: ander instappunt en andere hook, nooit dezelfde video met andere tekst.
- In "benodigdheden": locatie, props, schermopnames, stockbeelden, voice-over.`;

const EXAMEN_SYSTEM = `Je bent script-examinator voor short-form video. Je oordeelt NIET op eigen smaak maar toetst tegen twee vaste kaders die je meekrijgt: de storycraft-regels en de stijlbibliotheek.

Werkwijze, in deze volgorde:
1. CLASSIFICEER: welke stijl uit de bibliotheek gebruikt dit concept (of probeert het te gebruiken)? Benoem hem bij naam.
2. STIJLKEUZE: is dit de juiste stijl voor deze briefing en dit materiaal, volgens de stijlkeuze-regels onderaan de bibliotheek? Zo nee: herschrijf naar de stijl die wél past en zeg waarom.
3. STIJLREGELS: toets het concept tegen de harde regels van de gekozen stijl, inclusief de genoemde valkuil. Elke overtreding herstel je.
4. STORYCRAFT: toets op de algemene regels — één spanningslijn; "maar/dus" tussen elke twee shots; escalatie per stap; payoff lost de belofte van de hook letterlijk in; niets na de payoff.
5. BRIEFING EN CAMPAGNEREGELS: klopt het nog met wat er gevraagd is?
6. Lever het VOLLEDIGE verbeterde script en vul "zelfkritiek" in: de stijl waartegen je toetste, je oordeel over die stijlkeuze, het zwakste punt van het concept, de verhoorde keuzes met oordeel, en wat je verbeterd hebt.

Elke aanmerking verwijst naar een regel uit de kaders, niet naar een gevoel. Een middelmatig script doorlaten kost echte views.`;

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
export async function generateScript(
  brief: BriefInput,
  eerdereFeedback: { script: unknown; feedback: string }[] = [],
  opties: { vermijdStijlen?: string[] } = {},
): Promise<{ script: Script; vaultSnapshot: unknown }> {
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

  // Eerdere versies waar een mens feedback op gaf zijn de waardevolste input
  // die er is; die gaan integraal mee zodat dezelfde fout niet terugkomt.
  // Bij meerdere varianten per opdracht dwingen we stijldiversiteit af:
  // dezelfde stijl twee keer is geen tweede verhaallijn maar een herhaling.
  const stijlBlok =
    (opties.vermijdStijlen?.length ?? 0) > 0
      ? `\n\n=== STIJLEIS VOOR DEZE VARIANT ===\nDeze stijlen zijn al gebruikt in eerdere varianten van deze opdracht: ${opties.vermijdStijlen!.join(
          ', ',
        )}. Kies bewust een ANDERE stijl uit de bibliotheek die past bij de briefing, en bouw de verhaallijn vanuit die stijl op.`
      : '';

  const feedbackBlok =
    eerdereFeedback.length > 0
      ? `\n\n=== FEEDBACK OP EERDERE VERSIES (verwerk dit expliciet) ===\n${eerdereFeedback
          .map((f, n) => `--- versie ${n + 1} ---\nFeedback: ${f.feedback}\nScript was: ${JSON.stringify(f.script).slice(0, 3000)}`)
          .join('\n')}`
      : '';

  const bijgeleerd = await geleerdeKennis();

  const concept = await structuredCall({
    system: SCRIPT_SYSTEM + bijgeleerd,
    user: `=== BRIEFING ===
Titel: ${brief.titel}
Platform: ${brief.platform ?? 'nog niet bepaald'}
Beoogde duur: ${brief.duurSeconden ? `${brief.duurSeconden} seconden` : 'niet opgegeven'}
Doel: ${brief.doel ?? 'niet opgegeven'}

${brief.briefing}

=== CAMPAGNEREGELS ===
${JSON.stringify(brief.campaignRules ?? {}, null, 2)}

=== VAULT (onze gemeten kennis) ===
${renderVaultForPrompt(vault)}

${STORYCRAFT}\n\n${STORYSTIJLEN}\n\n${ONDERZOEK}\n\n${EFFECTEN}\n\n${EDITCRAFT}${scoutBlok}${feedbackBlok}${stijlBlok}`,
    schema: scriptSchema,
    toolName: 'lever_script',
    toolDescription: 'Lever het volledige script voor deze briefing.',
    maxTokens: 32000,
    effort: SCRIPT_EFFORT,
    operation: 'scriptwriter',
  });

  // Examinatie-pass: het concept wordt verhoord op zijn keuzes en herschreven
  // waar het faalt, vóórdat er iets naar buiten gaat. Twee ronden kosten twee
  // calls, maar het concept ongezien doorsturen is precies hoe je opsommingen
  // in plaats van verhalen krijgt.
  const script = await structuredCall({
    system: EXAMEN_SYSTEM + bijgeleerd,
    user: `=== CONCEPTSCRIPT (te verhoren en verbeteren) ===
${JSON.stringify(concept, null, 2)}

=== DE BRIEFING WAAR HET AAN MOET VOLDOEN ===
${brief.briefing}

=== CAMPAGNEREGELS ===
${JSON.stringify(brief.campaignRules ?? {}, null, 2)}

${STORYCRAFT}\n\n${STORYSTIJLEN}\n\n${ONDERZOEK}\n\n${EFFECTEN}\n\n${EDITCRAFT}${feedbackBlok}${stijlBlok}`,
    schema: scriptSchema,
    toolName: 'lever_verbeterd_script',
    toolDescription: 'Lever het volledige verbeterde script inclusief zelfkritiek.',
    maxTokens: 32000,
    effort: SCRIPT_EXAMEN_EFFORT,
    operation: 'scriptwriter_examen',
  });

  return { script, vaultSnapshot: vault };
}

/**
 * Genereert één of meer scriptvarianten voor een opgeslagen briefing en bewaart
 * elke variant als eigen versie. Elke volgende variant moet een andere stijl
 * uit de bibliotheek gebruiken, zodat je echt verschillende verhaallijnen
 * krijgt om uit te kiezen in plaats van drie keer hetzelfde idee.
 */
export async function runScriptwriterForBrief(briefId: string, aantal = 1) {
  const supabase = db();

  const { data: brief, error } = await supabase
    .from('briefs')
    .select('*, campaigns(platform_rules, theme)')
    .eq('id', briefId)
    .single();
  if (error) throw error;

  const { data: eerdere } = await supabase
    .from('brief_scripts')
    .select('script, feedback')
    .eq('brief_id', briefId)
    .not('feedback', 'is', null)
    .order('created_at', { ascending: true });

  const input = {
    titel: brief.titel,
    briefing: brief.briefing,
    doel: brief.doel,
    platform: brief.platform,
    duurSeconden: brief.duur_seconden,
    theme: brief.theme ?? (brief.campaigns as { theme?: string | null } | null)?.theme ?? null,
    campaignRules: (brief.campaigns as { platform_rules?: unknown } | null)?.platform_rules ?? {},
  };
  const feedback = (eerdere ?? []).map((e) => ({ script: e.script, feedback: e.feedback as string }));

  const resultaten: { scriptId: string; script: Script }[] = [];
  const gebruikteStijlen: string[] = [];

  // Cap op 11: zoveel stijlen telt de bibliotheek. Meer varianten dan stijlen
  // levert gedwongen herhaling op, geen extra keuze.
  for (let i = 0; i < Math.max(1, Math.min(aantal, 11)); i++) {
    const { script, vaultSnapshot } = await generateScript(input, feedback, {
      vermijdStijlen: gebruikteStijlen,
    });

    const stijl = script.zelfkritiek?.stijl;
    if (stijl) gebruikteStijlen.push(stijl);

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
    resultaten.push({ scriptId: row.id, script });
  }

  return { scriptId: resultaten[0].scriptId, script: resultaten[0].script, varianten: resultaten };
}
