import { z } from 'zod';
import { structuredCall } from '../claude';
import { FONTS } from '../roughcut/tekstkaarten';

const huisstijlSchema = z.object({
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .describe('Accentkleur als hexcode, overgenomen uit wat je in beeld ziet.'),
  font: z.string().describe('De sleutel van het gekozen font uit de lijst.'),
  waarom: z.string().describe('In één zin: wat je in beeld zag dat deze keuze rechtvaardigt.'),
});

export type HuisstijlKeuze = z.infer<typeof huisstijlSchema>;

/**
 * Bepaalt de huisstijl van een campagne door naar het bronmateriaal te kíjken
 * in plaats van er alleen over te lezen.
 *
 * Waarom niet puur rekenen op de dominante kleur, zoals eerst: een kleur alleen
 * maakt twee campagnes nog niet van elkaar te onderscheiden zolang de kaarten
 * verder identiek zijn. Het lettertype draagt minstens zoveel merk — een
 * financieel programma en een lifestyle-account horen niet in hetzelfde
 * schreefloze blok te staan.
 *
 * Eén call per campagne, daarna bewaard: dit kost dus vrijwel niets over de
 * looptijd van een campagne.
 */
export async function kiesHuisstijl(opties: {
  campagneNaam: string;
  briefing?: string | null;
  /** Frames uit de bronvideo of de thumbnail; hierop wordt echt gekeken. */
  beeldPaden: string[];
  gemetenAccent?: string | null;
}): Promise<HuisstijlKeuze> {
  const fontLijst = Object.entries(FONTS)
    .map(([sleutel, f]) => `- ${sleutel}: ${f.karakter}`)
    .join('\n');

  return structuredCall({
    system: `Je bepaalt de huisstijl voor de tekstkaarten van korte video's van één merk of programma.

Je kijkt naar het bronmateriaal en kiest twee dingen: een accentkleur en een lettertype. Die keuzes komen bovenop het beeld te liggen, dus ze moeten voelen alsof ze bij dít merk horen — niet bij een montagetool.

Voor de kleur: neem een kleur die in beeld al aanwezig is of er logisch bij hoort, en die genoeg contrast geeft om zwarte of witte tekst op te leggen. Vermijd modderige tussenkleuren en vermijd bijna-zwart of bijna-wit.

Voor het lettertype kies je uit deze lijst, op basis van het karakter van het materiaal:
${fontLijst}

Antwoord met de sleutel, niet met de naam. Onderbouw met wat je werkelijk in beeld zag — niet met wat je vermoedt over de branche.`,
    user: `Campagne: ${opties.campagneNaam}
${opties.briefing ? `Briefing: ${opties.briefing.slice(0, 1200)}` : ''}
${opties.gemetenAccent ? `De dominante verzadigde kleur uit de thumbnail is gemeten op ${opties.gemetenAccent}; neem die over als hij klopt, wijk af als je in beeld iets beters ziet.` : ''}

Kijk naar de bijgevoegde beelden en bepaal de huisstijl.`,
    schema: huisstijlSchema,
    toolName: 'lever_huisstijl',
    toolDescription: 'Lever de accentkleur en het lettertype voor deze campagne.',
    maxTokens: 2000,
    effort: 'low',
    operation: 'huisstijl',
    beeldPaden: opties.beeldPaden,
    // Een klassering met een korte lijst keuzes; daar is het lichte model voor.
    model: process.env.CLAUDE_LICHT_MODEL,
  });
}
