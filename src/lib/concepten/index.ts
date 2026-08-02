import { z } from 'zod';
import { structuredCall } from '../claude';
import { db } from '../supabase';
import { loadVault, renderVaultForPrompt } from '../vault';
import { ONDERZOEK } from '../vault/onderzoek';
import { STORYSTIJLEN } from '../vault/storystijlen';

const conceptenSchema = z.object({
  concepten: z
    .array(
      z.object({
        titel: z.string(),
        platform: z.enum(['tiktok', 'reels', 'shorts']),
        doel: z.string(),
        briefing: z
          .string()
          .describe('Volledige werkbriefing: het idee, de spanning, wat er gebeurt, waarom dit bij deze campagne past.'),
      }),
    )
    .min(3),
});

const CONCEPTEN_SYSTEM = `Je bedenkt clip-concepten voor een clipping-campagne. Je krijgt de campagneregels, onze gemeten vault-kennis, en wat er op dit moment op de platforms werkt (Scout-vondsten). Daaruit bedenk je ZELF zoveel mogelijk sterke, verschillende concepten — de gebruiker hoeft niets aan te leveren.

Eisen per concept:
- Een concreet idee met ingebouwde spanning, geen thema ("iets met humor" is geen concept).
- De briefing is direct werkbaar: wat gebeurt er, wat is de belofte, wat is de payoff.
- Concepten verschillen echt van elkaar: andere invalshoek, ander formaat, andere stijl uit de bibliotheek — geen vijf smaken van hetzelfde idee.
- Blijf strikt binnen de campagneregels; verboden content stel je niet voor.
- Gebruik de Scout-vondsten als bewijs voor wat werkt, niet om letterlijk te kopiëren.`;

/**
 * Bedenkt een batch opdrachten voor een campagne en bewaart ze als briefs,
 * zodat er geen briefing getypt hoeft te worden: de kennis zit al in de vault
 * en in de Scout-vondsten.
 */
export async function bedenkConcepten(campaignId: string, aantal = 8) {
  const begrensd = Math.max(3, Math.min(aantal, 15));
  const supabase = db();

  const { data: campagne, error } = await supabase.from('campaigns').select('*').eq('id', campaignId).single();
  if (error || !campagne) throw new Error('Campagne niet gevonden');

  const vault = await loadVault({ theme: campagne.theme ?? null });
  const { data: finds } = await supabase
    .from('scout_finds')
    .select('handle, platform, theme, caption, outlier_score, decoded')
    .not('decoded', 'is', null)
    .order('outlier_score', { ascending: false, nullsFirst: false })
    .limit(15);

  // Wat er al bedacht is, zodat een tweede batch geen herhaling wordt.
  const { data: bestaand } = await supabase
    .from('briefs')
    .select('titel')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(40);
  const bestaandBlok =
    bestaand && bestaand.length > 0
      ? `\n\n=== AL BEDACHT VOOR DEZE CAMPAGNE (verzin iets anders) ===\n${bestaand
          .map((b) => `- ${b.titel}`)
          .join('\n')}`
      : '';

  const parsed = await structuredCall({
    system: CONCEPTEN_SYSTEM,
    user: `Bedenk ${begrensd} concepten voor deze campagne.

=== CAMPAGNE ===
${campagne.name}
Regels: ${JSON.stringify(campagne.platform_rules ?? {}, null, 2)}

=== VAULT (onze gemeten kennis) ===
${renderVaultForPrompt(vault)}

=== WAT NU WERKT OP DE PLATFORMS (Scout) ===
${JSON.stringify(finds ?? [], null, 2)}

${STORYSTIJLEN}

${ONDERZOEK}${bestaandBlok}`,
    schema: conceptenSchema,
    toolName: 'lever_concepten',
    toolDescription: 'Lever de lijst clip-concepten.',
    maxTokens: 16000,
    effort: 'high',
    operation: 'campagne_concepten',
  });

  const { data: rijen, error: insertError } = await supabase
    .from('briefs')
    .insert(
      parsed.concepten.slice(0, begrensd).map((c) => ({
        campaign_id: campaignId,
        titel: c.titel,
        briefing: c.briefing,
        doel: c.doel,
        platform: c.platform,
        status: 'concept',
      })),
    )
    .select('id, titel');
  if (insertError) throw insertError;

  return rijen ?? [];
}
