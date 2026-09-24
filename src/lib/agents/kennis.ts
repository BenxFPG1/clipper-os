import { z } from 'zod';
import { structuredCall } from '../claude';
import { db } from '../supabase';
import { loadThemes } from '../vault';
import { bewaarKennis } from '../vault/kennis';
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
        bron: z
          .string()
          .describe('Controleerbare bron: een URL, of een publicatie met auteur en jaar (bv. "Loewenstein, 1994, Psychological Bulletin"). Zonder dit vervalt het voorstel.'),
        waarom_waardevol: z.string(),
      }),
    )
    .max(3),
  samenvatting: z.string(),
});

/**
 * Zoekhoeken die per week roteren, zodat de agent niet elke maandag dezelfde
 * drie vragen stelt en steeds dezelfde artikelen vindt. De weeknummer-index
 * maakt het deterministisch en herhaalt na acht weken — dan is er ook echt
 * nieuw materiaal.
 */
export const ZOEKHOEKEN: string[][] = [
  ['retentiecurves van short-form video: waar valt de kijker af en wat houdt hem vast', 'hook-formules die in retentiedata aantoonbaar beter scoren'],
  ['platformmechanieken: wat TikTok, Instagram en YouTube dit jaar veranderden aan distributie van shorts', 'afkijkratio versus lengte: nieuwe cijfers'],
  ['editanalyses van goed presterende makers: knipritme, tekst-in-beeld, geluid', 'ondertiteling en tekstoverlay: leesbaarheid en plaatsing volgens onderzoek'],
  ['dramaturgie voor korte vorm: omslagpunt, inzet, payoff in onder een minuut', 'narratieve transportatie en nieuwsgierigheid: recente studies'],
  ['podcast- en interviewclips: wat werkt bij geknipte lange video\'s', 'comedy-timing in clips: waar knip je een lach af'],
  ['b-roll en beeldwisselingen: effect op retentie en begrip', 'muziek en sound design onder gesproken clips: onderzoek en praktijk'],
  ['captions, titels en eerste frame: wat bepaalt de klik en de eerste 3 seconden', 'commentaar en shares: welke clipvormen lokken reacties uit'],
  ['Nederlandstalige short-form: wat werkt anders dan in de Engelstalige markt', 'creator-economie en platformbeleid dat clipmakers raakt'],
];

const KENNIS_SYSTEM = `Je bent de kennis-agent van een clipping-tool. Eén keer per week doe je webresearch naar wat er NIEUW of ONDERBELICHT is in short-form storytelling en editing, en stel je hooguit drie aanvullingen op de kennisvault voor.

Werkwijze:
1. Lees eerst de bestaande kaders hieronder. Wat daar al staat, stel je NIET opnieuw voor — ook niet in andere woorden.
2. Zoek gericht op het web langs de zoekhoeken van deze week. Gebruik de huidige datum: "recent" betekent de afgelopen twaalf maanden, en je vermeldt het jaar van elke bron.
3. Alleen kennis die een concrete beslissing verandert in een clip-plan, script of edit is een voorstel waard. "Wees authentiek" is geen kennis; "een lach nooit op de eerste piek afkappen" wel.
4. Elke aanvulling heeft een controleerbare bron: een URL, of een publicatie met auteur en jaar. Geen bron = geen voorstel.
5. Weeg wat je vindt tegen onze thema's: kennis die alleen voor een niche geldt waar wij niet in werken, laat je liggen.
6. Liever nul goede voorstellen dan drie vage. Een lege lijst is een prima uitkomst.`;

/** URL, of iets dat als publicatie leest: een naam met een jaartal tussen 1990 en nu. */
export function bronIsControleerbaar(bron: string): boolean {
  const b = bron.trim();
  if (/https?:\/\/\S{6,}/i.test(b)) return true;
  if (/\bdoi:\s*10\.\d{4,}/i.test(b)) return true;
  const jaar = b.match(/\b(19[9]\d|20[0-3]\d)\b/);
  return Boolean(jaar) && /\p{Lu}\p{L}{2,}/u.test(b) && b.length >= 12;
}

function weeknummer(d = new Date()): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / (7 * 24 * 3600 * 1000));
}

/**
 * Wekelijkse zelftraining van de vault: researcht het web en vult de kaders
 * aan via de vault_kennis-tabel. De basisteksten in de code blijven onaangetast;
 * aanvullingen zijn per stuk zichtbaar en uitzetbaar op de Vault-pagina.
 */
export async function runKennisAgent() {
  const supabase = db();

  const [{ data: bestaand }, themes] = await Promise.all([
    supabase.from('vault_kennis').select('titel, inhoud, actief').order('created_at'),
    loadThemes().catch(() => []),
  ]);

  const eerderGeleerd =
    bestaand && bestaand.length > 0
      ? `\n\n=== EERDER BIJGELEERD (niet herhalen; inactieve zijn door een mens afgekeurd) ===\n${bestaand
          .map((k) => `- [${k.actief ? 'actief' : 'AFGEKEURD'}] ${k.titel}: ${(k.inhoud as string).slice(0, 140)}`)
          .join('\n')}`
      : '';

  const vandaag = new Date();
  const hoeken = ZOEKHOEKEN[weeknummer(vandaag) % ZOEKHOEKEN.length];
  const themaTekst =
    themes.length > 0
      ? themes.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ''}`).join('\n')
      : '- (nog geen thema\'s ingesteld; ga uit van Nederlandstalige podcast-, interview- en comedyclips)';

  const resultaat = await structuredCall({
    system: KENNIS_SYSTEM,
    user: `Vandaag is ${vandaag.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}. Doe je wekelijkse research en lever hooguit drie aanvullingen.

=== ONZE THEMA'S (waar wij clips voor maken) ===
${themaTekst}

=== ZOEKHOEKEN VAN DEZE WEEK (begin hier; wijk af als je onderweg iets sterkers vindt) ===
${hoeken.map((h, i) => `${i + 1}. ${h}`).join('\n')}

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

  // Bron-eis in code afgedwongen, niet alleen in de prompt: zonder URL of
  // publicatie-vermelding is een regel niet te controleren en gaat hij niet
  // de vault in. Dedup via bewaarKennis.
  let bewaard = 0;
  const afgevallen: string[] = [];
  for (const v of resultaat.voorstellen) {
    if (!bronIsControleerbaar(v.bron)) {
      afgevallen.push(`${v.titel} (bron niet controleerbaar: ${v.bron.slice(0, 60)})`);
      continue;
    }
    const r = await bewaarKennis({ categorie: v.categorie, titel: v.titel, inhoud: v.inhoud, bron: v.bron });
    if (r.bewaard) bewaard++;
    else afgevallen.push(`${v.titel} (duplicaat op ${r.reden})`);
  }

  await supabase.from('agent_runs').insert({
    agent: 'kennis',
    status: 'auto',
    input_summary: { zoekhoeken: hoeken, bewaard, afgevallen },
    proposal: resultaat,
    decided_by: 'auto',
  });

  return { ...resultaat, bewaard, afgevallen };
}
