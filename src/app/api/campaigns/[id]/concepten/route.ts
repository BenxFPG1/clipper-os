import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { SchemaValidationError, structuredCall } from '@/lib/claude';
import { db } from '@/lib/supabase';
import { loadVault, renderVaultForPrompt } from '@/lib/vault';
import { ONDERZOEK } from '@/lib/vault/onderzoek';
import { STORYSTIJLEN } from '@/lib/vault/storystijlen';

export const maxDuration = 300;

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
 * Bedenkt automatisch een batch opdrachten voor deze campagne, zodat je geen
 * briefings hoeft te typen: de kennis zit al in de vault en de Scout-vondsten.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as { aantal?: number };
  const aantal = Math.max(3, Math.min(body.aantal ?? 6, 10));

  const supabase = db();
  const { data: campagne, error } = await supabase.from('campaigns').select('*').eq('id', params.id).single();
  if (error || !campagne) return NextResponse.json({ error: 'Campagne niet gevonden' }, { status: 404 });

  try {
    const vault = await loadVault({ theme: campagne.theme ?? null });
    const { data: finds } = await supabase
      .from('scout_finds')
      .select('handle, platform, theme, caption, outlier_score, decoded')
      .not('decoded', 'is', null)
      .order('outlier_score', { ascending: false, nullsFirst: false })
      .limit(15);

    const parsed = await structuredCall({
      system: CONCEPTEN_SYSTEM,
      user: `Bedenk ${aantal} concepten voor deze campagne.

=== CAMPAGNE ===
${campagne.name}
Regels: ${JSON.stringify(campagne.platform_rules ?? {}, null, 2)}

=== VAULT (onze gemeten kennis) ===
${renderVaultForPrompt(vault)}

=== WAT NU WERKT OP DE PLATFORMS (Scout) ===
${JSON.stringify(finds ?? [], null, 2)}

${STORYSTIJLEN}

${ONDERZOEK}`,
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
        parsed.concepten.slice(0, aantal).map((c) => ({
          campaign_id: params.id,
          titel: c.titel,
          briefing: c.briefing,
          doel: c.doel,
          platform: c.platform,
          status: 'concept',
        })),
      )
      .select('id, titel');
    if (insertError) throw insertError;

    return NextResponse.json({ briefs: rijen });
  } catch (e) {
    if (e instanceof SchemaValidationError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
