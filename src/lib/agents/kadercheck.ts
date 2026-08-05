import { z } from 'zod';
import { structuredCall } from '../claude';

const checkSchema = z.object({
  shots: z.array(
    z.object({
      volgorde: z.number().int().min(1),
      goed: z.boolean().describe('Staat de spreker correct in beeld?'),
      probleem: z
        .string()
        .describe('Wat er mis is, in wat je ziet. Leeg als het goed is.'),
      correctie: z
        .enum(['geen', 'naar_links', 'naar_rechts', 'uitzoomen', 'inzoomen', 'hoger', 'lager'])
        .describe('De ingreep die dit oplost.'),
      sterkte: z
        .number()
        .min(0)
        .max(1)
        .describe('Hoe groot de ingreep moet zijn: 0,2 is een tikje, 1 is maximaal.'),
    }),
  ),
});

export type KaderOordeel = z.infer<typeof checkSchema>;

const SYSTEM = `Je controleert de kadrering van een verticale clip. Je krijgt per shot één beeld: precies wat de kijker straks ziet.

Je oordeelt alleen over wat er in beeld staat, niet over de inhoud. Fout is:
- het hoofd is aangesneden (kruin, kin of een oor valt buiten beeld)
- de spreker staat half in beeld of tegen de rand geplakt
- er staat geen mens in beeld terwijl het een sprekend shot is (alleen decor, een muur, een kast)
- je ziet de naad van een split screen, of twee halve mensen
- de persoon staat zo klein dat je zijn gezicht niet leest
- het hoofd staat zo groot dat het beeld benauwd wordt

Goed is: één persoon herkenbaar in beeld, hoofd compleet, ogen op ongeveer een derde van boven, en genoeg ruimte aan de kant waar hij naartoe kijkt.

Wees streng maar niet perfectionistisch: twijfel je, dan is het goed. Elke correctie kost een extra ronde.

Kies bij een fout de kleinste ingreep die het oplost. "naar_links" betekent: de uitsnede moet naar links, dus de persoon schuift naar rechts in beeld.`;

/**
 * Laat de edit-agent kijken naar wat er werkelijk in beeld komt en zeggen wat
 * eraan moet veranderen.
 *
 * Waarom naast de rekenkundige controle: die weet of het gezichtsvak binnen de
 * uitsnede valt, maar niet of het er goed uitziet. Een uitsnede zonder mens
 * erin, een zichtbare split-screen-naad of een benauwd kader zijn geen
 * rekenfouten — die moet je zien.
 *
 * Draait op het lichte model met lage effort: het is een oordeel over een
 * handvol beelden, geen creatief werk.
 */
export async function controleerKaderVisueel(
  beelden: { volgorde: number; pad: string }[],
): Promise<KaderOordeel> {
  return structuredCall({
    system: SYSTEM,
    user: `Hier zijn ${beelden.length} beelden, in deze volgorde: ${beelden
      .map((b) => `shot ${b.volgorde}`)
      .join(', ')}.

Beoordeel per shot of de spreker goed in beeld staat, en geef bij een fout de kleinste ingreep die het oplost.`,
    schema: checkSchema,
    toolName: 'lever_kaderoordeel',
    toolDescription: 'Lever per shot het oordeel over de kadrering.',
    maxTokens: 4000,
    effort: 'low',
    operation: 'kadercontrole',
    beeldPaden: beelden.map((b) => b.pad),
    model: process.env.CLAUDE_LICHT_MODEL,
  });
}
