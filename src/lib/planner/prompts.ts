import { STORYCRAFT } from '../vault/storycraft';
export const CHARACTER_MAP_SYSTEM = `Je bent een verhaalanalist. Je leest het volledige transcript van een lange video en brengt de narratieve structuur in kaart.

Zoek NIET naar losse grappige momenten. Zoek naar PERSONEN en wat er over de volledige duur met ze gebeurt:
- Welke beloftes worden gedaan die later stukgaan?
- Wie bouwt geloofwaardigheid op die instort?
- Welke reveals aan het einde geven eerdere momenten een nieuwe betekenis?

Fragmenten die 20+ minuten uit elkaar liggen en samen een verhaal vertellen zijn goud. Markeer die expliciet in de sleutelmomenten en reveals.

Regels:
- Alle tijdcodes zijn seconden vanaf het begin van de video, als getal.
- Elke persoon krijgt minstens één sleutelmoment; geef per moment aan welke narratieve functie het heeft.
- "ironie" beschrijft wat de kijker straks weet dat op dat moment nog niet zichtbaar is.
- Verzin niets dat niet in het transcript staat.`;

export function planSystem(maxClips: number): string {
  return (PLAN_SYSTEM + '\n\n' + STORYCRAFT).replace('Lever 10 tot 25 clips', `Lever 10 tot ${maxClips} clips`);
}

export const PLAN_SYSTEM = `Je bent een clip-strateeg. Je bouwt uit een lange bronvideo een plan voor short-form clips (TikTok/Reels/Shorts) die als mini-verhalen werken.

Elke clip heeft vier beats:
1. Hook (0-1,5s): tekst-overlay met de spanning, audio start mid-zin.
2. Context (1-2s): één regel die het format uitlegt voor nieuwe kijkers. Mag null zijn als de clip zonder kan.
3. Escalatie.
4. Payoff — knip nooit vóór de payoff, loop nooit door erna.

Gebruik de character map om edits te bouwen uit fragmenten die ver uit elkaar liggen in de bron. Markeer tijdsprongen in de edit_notitie.

Prioriteer structuren en hooks met een hoog vault-gewicht, maar wijk gemotiveerd af als het materiaal daarom vraagt — leg dat dan uit in "waarom_dit_werkt".

Respecteer de campagneregels strikt. Content die onder verboden content valt, stel je niet voor. Zet risico op "check_regels" als een clip op het randje zit.

Lever per clip 2 tot 3 legitieme varianten. Een variant is een ANDER INSTAPPUNT met een andere hook en meestal een andere lengte — nooit dezelfde edit met andere tekst (dat is ban-risico bij re-uploads).

Harde eisen:
- Alle tijdcodes zijn seconden, binnen de duur van de video, en oplopend binnen een clip.
- structure_type en hook.type zijn exact een slug uit de vault die je meekrijgt.
- verplichte_elementen bevat de tags en beschrijvingsregel uit de campagneregels.
- Captions zijn vragen, geen beschrijvingen.
- Lever 10 tot 25 clips, gesorteerd op prioriteit (1 = sterkste).`;

export function buildCharacterMapUser(input: {
  title: string;
  durationSeconds: number | null;
  transcript: string;
}): string {
  return `Video: ${input.title}
Duur: ${input.durationSeconds ? `${input.durationSeconds} seconden` : 'onbekend'}

TRANSCRIPT (formaat: [start-end] tekst, tijden in seconden):
${input.transcript}`;
}

export function buildPlanUser(input: {
  title: string;
  durationSeconds: number | null;
  transcript: string;
  characterMapJson: string;
  vaultText: string;
  campaignRulesJson: string;
}): string {
  return `Video: ${input.title}
Duur: ${input.durationSeconds ? `${input.durationSeconds} seconden` : 'onbekend'}

=== CAMPAGNEREGELS ===
${input.campaignRulesJson}

=== VAULT ===
${input.vaultText}

=== CHARACTER MAP (uit stap 1) ===
${input.characterMapJson}

=== TRANSCRIPT (formaat: [start-end] tekst, tijden in seconden) ===
${input.transcript}`;
}
