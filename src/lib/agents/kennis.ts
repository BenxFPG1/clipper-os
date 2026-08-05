import { z } from 'zod';
import { structuredCall } from '../claude';
import { db } from '../supabase';
import { STORYCRAFT } from '../vault/storycraft';
import { STORYSTIJLEN } from '../vault/storystijlen';
import { ONDERZOEK } from '../vault/onderzoek';
import { EFFECTEN } from '../vault/effecten';
import { EDITCRAFT } from '../vault/editcraft';

const voorstelSchema = z.object({
  voorstellen: z
    .array(
      z.object({
        categorie: z.enum(['storycraft', 'editcraft', 'onderzoek']),
        titel: z.string().max(80),
        inhoud: z
          .string()
          .describe('De regel(s) kennis, in dezelfde toon als de bestaande kaders: concreet, toetsbaar, toegepast op clips.'),
        bron: z.string().describe('Waar dit vandaan komt (publicatie, maker, studie), zodat het controleerbaar blijft.'),
        waarom_waardevol: z.string(),
      }),
    )
    .max(3),
  samenvatting: z.string(),
});

const KENNIS_SYSTEM = `Je bent de kennis-agent van een clipping-tool. Eén keer per week doe je webresearch naar wat er NIEUW of ONDERBELICHT is in short-form storytelling en editing, en stel je hooguit drie aanvullingen op de kennisvault voor.

Werkwijze:
1. Lees eerst de bestaande kaders hieronder. Wat daar al staat, stel je NIET opnieuw voor — ook niet in andere woorden.
2. Zoek gericht op het web: recente retentiestudies, nieuwe platformmechanieken, editanalyses van goed presterende makers, dramaturgie die we nog missen.
3. Alleen kennis die een concrete beslissing verandert in een clip-plan, script of edit is een voorstel waard. "Wees authentiek" is geen kennis; "een lach nooit op de eerste piek afkappen" wel.
4. Elke aanvulling heeft een controleerbare bron. Geen bron = geen voorstel.
5. Liever nul goede voorstellen dan drie vage. Een lege lijst is een prima uitkomst.`;

/**
 * Wekelijkse zelftraining van de vault: researcht het web en vult de kaders
 * aan via de vault_kennis-tabel. De basisteksten in de code blijven onaangetast;
 * aanvullingen zijn per stuk zichtbaar en uitzetbaar op de Vault-pagina.
 */
export async function runKennisAgent() {
  const supabase = db();

  const { data: bestaand } = await supabase
    .from('vault_kennis')
    .select('titel, inhoud, actief')
    .order('created_at');

  const eerderGeleerd =
    bestaand && bestaand.length > 0
      ? `\n\n=== EERDER BIJGELEERD (niet herhalen; inactieve zijn door een mens afgekeurd) ===\n${bestaand
          .map((k) => `- [${k.actief ? 'actief' : 'AFGEKEURD'}] ${k.titel}: ${(k.inhoud as string).slice(0, 140)}`)
          .join('\n')}`
      : '';

  const resultaat = await structuredCall({
    system: KENNIS_SYSTEM,
    user: `Doe je wekelijkse research en lever hooguit drie aanvullingen.

=== BESTAANDE KADERS (niet herhalen) ===
${STORYCRAFT}

${STORYSTIJLEN}

${ONDERZOEK}

${EFFECTEN}

${EDITCRAFT}${eerderGeleerd}`,
    schema: voorstelSchema,
    toolName: 'lever_kennis',
    toolDescription: 'Lever de kennisaanvullingen van deze week.',
    maxTokens: 16000,
    effort: 'high',
    operation: 'kennis_agent',
    webResearch: true,
  });

  for (const v of resultaat.voorstellen) {
    await supabase.from('vault_kennis').insert({
      categorie: v.categorie,
      titel: v.titel,
      inhoud: v.inhoud,
      bron: v.bron,
    });
  }

  await supabase.from('agent_runs').insert({
    agent: 'kennis',
    status: 'auto',
    proposal: resultaat,
    decided_by: 'auto',
  });

  return resultaat;
}
