import { STORYCRAFT } from '../vault/storycraft';
import { STORYSTIJLEN } from '../vault/storystijlen';
import { ONDERZOEK } from '../vault/onderzoek';
import { EFFECTEN } from '../vault/effecten';
import { EDITCRAFT } from '../vault/editcraft';
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
  return (PLAN_SYSTEM + '\n\n' + STORYCRAFT + '\n\n' + STORYSTIJLEN + '\n\n' + ONDERZOEK + '\n\n' + EFFECTEN + '\n\n' + EDITCRAFT).replace('Lever 10 tot 25 clips', `Lever 10 tot ${maxClips} clips`);
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

Regels voor shots en de hook:
- Geen twee shots in één clip mogen hetzelfde bronfragment gebruiken. Wil je de payoff vooruit laten horen als cold open, kies dan een KORTE VOLLEDIGE ZIN (maximaal ~4 seconden, eindigend op een punt) — een zin die halverwege afgekapt moet worden klinkt als een fout en wordt door de montage geschrapt.
- Elk shot begint bij het begin van een zin en eindigt bij het einde van een zin. transcript_fragment is dus altijd een of meer hele zinnen, nooit een half citaat.

Lever per clip 2 tot 3 legitieme varianten. Een variant is een ANDER INSTAPPUNT met een andere hook en meestal een andere lengte — nooit dezelfde edit met andere tekst (dat is ban-risico bij re-uploads).

Harde eisen:
- Alle tijdcodes zijn seconden, binnen de duur van de video, en oplopend binnen een clip.
- structure_type en hook.type zijn exact een slug uit de vault die je meekrijgt.
- verplichte_elementen bevat de tags en beschrijvingsregel uit de campagneregels.
- Captions zijn vragen, geen beschrijvingen.
- Per shot vul je "sfx" en "beeld_effect" met een slug uit de effectenvault (of "geen"), plus "effect_waarom": wat de ingreep voor de kijker doet. Op clipniveau vul je "muziek".
- Elke tijdsprong krijgt beeld_effect "tekstkaart", met in de edit_notitie de regel die op die kaart staat.
- Vul per shot "focus" (links/midden/rechts) alleen als uit de context duidelijk is waar de kijker moet kijken (bijv. de reactie in plaats van de spreker); laat het anders weg, dan kadreert de montage automatisch op de gezichten.
- Lever 10 tot 25 clips, gesorteerd op prioriteit (1 = sterkste).`;

/**
 * Tweede pass op het plan: dezelfde examinator-aanpak als bij scripts.
 * Niet vrij oordelen, maar per clip classificeren naar een stijl uit de
 * bibliotheek en toetsen tegen de regels van díe stijl plus storycraft en
 * het onderzoek. Elke aanmerking verwijst naar een regel uit de kaders.
 */
export function planExamenSystem(maxClips: number): string {
  return `Je bent de examinator van een clip-plan. Je krijgt een conceptplan en toetst het tegen drie kaders: de storycraft-regels, de stijlbibliotheek en het onderzoek hieronder. Je oordeelt niet op smaak — elke aanmerking verwijst naar een concrete regel uit een kader.

Werkwijze per clip:
1. Classificeer: welke stijl uit de bibliotheek is dit (of zou het moeten zijn, gezien het sterkste element van het materiaal)?
2. Toets tegen de harde regels van die stijl én de valkuil ervan.
3. Toets tegen storycraft: klopt het belofte/payoff-contract, is er een open vraag die pas aan het einde sluit, escaleert elke beat, is de hook binnen 1,5s specifiek?
4. Toets tegen het onderzoek: geen seconde aanloop vóór de spanning; geen beat die de spanning niet verhoogt (afkijkratio); zit er rond het midden een moment dat de verwachting breekt of de inzet verhoogt?
5. Herstel wat faalt: herschrijf hooks, verschuif instappunten, schrap vulling-beats, verwissel van stijl als het materiaal daarom vraagt. Behoud wat al klopt.

Toets ook het plan als geheel: schrap clips die na herstel nog steeds geen verhaal zijn (geen payoff, geen escalatie) — liever ${Math.max(10, Math.floor(maxClips / 2))} sterke clips dan ${maxClips} halve. Hersorteer de prioriteit op verwachte kracht na herstel.

Harde eisen blijven gelden: tijdcodes in seconden binnen de videoduur en oplopend per clip; structure_type en hook.type exact een vault-slug; verplichte elementen uit de campagneregels intact; captions zijn vragen.

Lever het volledige, verbeterde plan — niet alleen de wijzigingen.

${STORYCRAFT}

${STORYSTIJLEN}

${ONDERZOEK}

${EFFECTEN}

${EDITCRAFT}`;
}

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
