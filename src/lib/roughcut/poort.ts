import type { Shot } from './index';
import type { BronWoord } from './woorden';
import { instelling } from './instellingen';

/**
 * Langer dan dit is een cold open geen tease meer maar een duplicaat. Zelfde
 * grens als de worker hanteert bij het markeren.
 */
export const TEASE_MAX_DUUR = 4.5;

/**
 * De poort: het laatste wat er met de segmenten gebeurt vóór het renderen.
 *
 * Waarom deze bestaat, en waarom hij het verschil maakt met alles wat eraan
 * voorafging: de montage kent vijftien stappen die allemaal in dezelfde
 * segmenten schrijven — uitlijnen, snappen, dode lucht, knipcontrole,
 * herstellussen, kadercorrecties. Elke stap klopte op zichzelf, maar de
 * cómbinaties had niemand doorgerekend, en dus kon een fix voor het ene
 * probleem het andere weer stukmaken. Precies dat patroon van "je repareert
 * iets en de volgende keer is het weer kapot".
 *
 * De oplossing is niet nog een stap, maar een flessenhals. Alles mag hier
 * bovenstrooms van alles vinden; wat híer uitkomt voldoet aan een klein aantal
 * harde regels, of het wordt teruggeduwd tot het eraan voldoet. Er is geen weg
 * naar de renderer omheen.
 *
 * De regels zijn bewust rekenkundig, niet oordeelkundig — ze hebben geen
 * drempel die per bron anders ligt en geen model dat zich kan vergissen:
 *
 *  1. Geen knip valt binnen een woord. We kennen de woordtijden van de hele
 *     bron; ligt een grens strikt tussen begin en eind van een woord, dan
 *     gaat hij naar de rand die het woord bij zijn eigen zin laat: hoort het
 *     bij het scriptfragment van het shot (het eerste of laatste woord), dan
 *     komt het mee, anders valt het erbuiten.
 *  1b. Rond elke knip staat ademruimte, begrensd door de werkelijke stilte tot
 *     het buurwoord — een knip pal op de woordgrens klinkt afgebeten.
 *  2. Geen twee segmenten delen bronmateriaal, want dan hoort de kijker
 *     dezelfde woorden twee keer. Eén uitzondering: een kórte cold open
 *     (`tease`) mag de payoff bewust vooruit laten horen.
 *  3. Segmenten zijn niet omgekeerd of te kort om te bestaan.
 *
 * Elke ingreep wordt gerapporteerd. Grijpt de poort ergens in, dan is dat per
 * definitie een bug bovenstrooms: het rapport is de plek waar je die vindt.
 */

export type PoortIngreep = {
  volgorde: number;
  regel: 'halfFragment' | 'woordgrens' | 'overlap' | 'ongeldig' | 'tease';
  wat: string;
};

/**
 * De enige juiste manier om een segmentgrens bewust te verzetten.
 *
 * ankerStart/ankerEind zijn de waarheid waar regel 0 (halfFragment) op
 * vertrouwt. Elke correctielaag die start/end verzette maar het anker liet
 * staan, kreeg zijn correctie de eerstvolgende poortronde straal
 * teruggetrokken naar het oude, inmiddels foute anker — een stille
 * touwtrekwedstrijd die rondenlang doorging zonder één foutmelding. Die bug
 * is op negen losse plekken gevonden; deze helper maakt de hele klasse
 * onmogelijk in plaats van per plek gefixt. Verzet een grens dus nooit met
 * een kale toewijzing, maar hiermee.
 */
export function verzetGrens(seg: Shot, wijziging: { start?: number; end?: number }): void {
  if (wijziging.start !== undefined) {
    seg.start = wijziging.start;
    seg.ankerStart = wijziging.start;
  }
  if (wijziging.end !== undefined) {
    seg.end = wijziging.end;
    seg.ankerEind = wijziging.end;
  }
}

const kaal = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Zelfde woord, met de spelling van spraakherkenning en plan ernaast ("Platina-markt" / "Platinamarkt", "verspelbaar" / "voorspelbaar"). */
function zelfdeWoord(a: string, b: string): boolean {
  const x = kaal(a);
  const y = kaal(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x))) return true;
  // Het tweede deel van een gesplitst samengesteld woord ("-Afrika." bij
  // "Zuid-Afrika.") is ook dat woord.
  if (Math.min(x.length, y.length) >= 4 && (x.endsWith(y) || y.endsWith(x))) return true;
  if (Math.min(x.length, y.length) < 4 || Math.abs(x.length - y.length) > 2) return false;
  // Hoogstens twee letters verschil.
  const d: number[] = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let vorige = d[0];
    d[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, vorige + (x[i - 1] === y[j - 1] ? 0 : 1));
      vorige = t;
    }
  }
  return d[y.length] <= 2;
}

/**
 * Welke kant op met een knip die midden in een woord valt.
 *
 * Altijd naar buiten (het hele woord mee) was fout zodra het woord bij de
 * buurzin hoorde. PLATINA clip 3: shot 5 begon 0,02 s vóór het einde van
 * "politiek." (de vorige zin) en kreeg dat woord erbij; shot 4.01 eindigde in
 * "En" (de volgende zin) en kreeg dat erbij. Daarna overlapten ze en viel
 * shot 4.01 met zijn hele zin weg — "En platina beweegt ook daarop" zonder
 * waarop. Clip 2: "…ter sprake komt, geconcentreerd. Meer dan 70%".
 *
 * Nu: is het buurwoord aan de binnenkant het randwoord van het fragment, dan
 * hoort dit woord bij de buurzin en valt het erbuiten. Is het zelf een van de
 * eerste (bij een start) of laatste (bij een eind) drie woorden van het
 * fragment, dan komt het mee. Anders de dichtstbijzijnde rand.
 */
function kantVanWoord(
  w: BronWoord,
  t: number,
  randwoorden: string[],
  binnenBuur: BronWoord | null,
  kant: 'start' | 'eind',
): 'mee' | 'erbuiten' {
  // Een gesplitst samengesteld woord ("Zuid" + "-Afrika.", "Troy" + "-ounce.")
  // is één woord: nooit doormidden. Zonder deze regel eindigde PLATINA clip 2
  // op "…komt uit Zuid." en "…297.000 troy.".
  if (kant === 'eind' && (w.w.startsWith('-') || binnenBuur?.w.endsWith('-'))) return 'mee';
  if (kant === 'start' && (w.w.endsWith('-') || binnenBuur?.w.startsWith('-'))) return 'mee';
  // Eerst de buur: bij korte woorden ("en", "de") zegt het woord zelf weinig,
  // de plek ten opzichte van het randwoord van het fragment wel.
  if (randwoorden.length && binnenBuur && zelfdeWoord(binnenBuur.w, randwoorden[0]) && !zelfdeWoord(w.w, randwoorden[0])) return 'erbuiten';
  if (randwoorden.some((r) => zelfdeWoord(w.w, r))) return 'mee';
  const midden = (w.s + w.e) / 2;
  if (kant === 'start') return t <= midden ? 'mee' : 'erbuiten';
  return t >= midden ? 'mee' : 'erbuiten';
}

/** Het scriptfragment van een shot; een deelshot (4.01) erft dat van zijn hoofdshot. */
function fragmentVan(seg: Shot, alle: Shot[]): string | null {
  const eigen = (seg as { transcript_fragment?: string }).transcript_fragment;
  if (eigen) return eigen;
  const hoofd = alle.find((x) => Math.floor(x.volgorde) === Math.floor(seg.volgorde) && (x as { transcript_fragment?: string }).transcript_fragment);
  return (hoofd as { transcript_fragment?: string } | undefined)?.transcript_fragment ?? null;
}

/** Het woord waar dit tijdstip middenin valt, of null. */
export function woordOnder(woorden: BronWoord[], t: number, marge = 0.02): BronWoord | null {
  for (const w of woorden) {
    if (t > w.s + marge && t < w.e - marge) return w;
    // De lijst is oplopend; voorbij het tijdstip hoeven we niet verder.
    if (w.s > t + 1) break;
  }
  return null;
}

export function poort(
  segmenten: Shot[],
  bronWoorden: BronWoord[] | null,
): { segmenten: Shot[]; ingrepen: PoortIngreep[] } {
  const ingrepen: PoortIngreep[] = [];
  let uit = [...segmenten].sort((a, b) => a.volgorde - b.volgorde);

  // Regel 0: geen half fragment. Een shot moet het hele stuk tekst bevatten
  // dat het script eraan toekent — niet een deel ervan.
  //
  // Dit is de regel die het langst ontbrak, en het verschil met regel 1 is
  // wezenlijk: een knip kan keurig op een woordgrens vallen en de zín toch
  // doormidden hakken. Precies dat gebeurde toen de cold open werd afgekapt op
  // een punt die de transcriptie verzonnen had ("Het zal goud door die grote
  // volatiliteit." terwijl de zin doorloopt met "de komende jaren nog opnieuw
  // gaan verdubbelen"). Interpunctie uit spraakherkenning is geen bewijs van
  // een zinseinde; het scriptfragment wél, want dat is wat een mens bedoelde.
  //
  // Wordt een shot hierdoor een duplicaat van een ander, dan lost regel 2 dat
  // daarna op — inkorten of laten vervallen, maar nooit halveren.
  for (const seg of uit) {
    if (seg.ankerEind !== undefined && seg.end < seg.ankerEind - 0.15) {
      ingrepen.push({
        volgorde: seg.volgorde,
        regel: 'halfFragment',
        wat: `eindigde op ${seg.end.toFixed(2)}, midden in zijn fragment; hersteld naar ${seg.ankerEind.toFixed(2)}`,
      });
      seg.end = seg.ankerEind;
    }
    if (seg.ankerStart !== undefined && seg.start > seg.ankerStart + 0.15) {
      ingrepen.push({
        volgorde: seg.volgorde,
        regel: 'halfFragment',
        wat: `begon op ${seg.start.toFixed(2)}, na het begin van zijn fragment; hersteld naar ${seg.ankerStart.toFixed(2)}`,
      });
      seg.start = seg.ankerStart;
    }
  }

  // Regel 1: geen knip middenin een woord.
  if (bronWoorden && bronWoorden.length > 0) {
    for (const [i, seg] of uit.entries()) {
      // Een naad waar het vorige shot precies ophoudt waar dit begint (een
      // camerawissel in de bron, een kaderwissel) is geen knip in het geluid:
      // de spraak loopt door. Die grens verzetten zou juist een stukje woord
      // dubbel laten klinken.
      const doorlopendVoor = i > 0 && Math.abs(uit[i - 1].end - seg.start) < 0.005;
      const doorlopendNa = i + 1 < uit.length && Math.abs(uit[i + 1].start - seg.end) < 0.005;
      // Het fragment telt alleen aan de buitenkant van een shot: het begin
      // van het eerste deel en het eind van het laatste deel.
      const fragment = fragmentVan(seg, uit);
      const woordenFragment = fragment ? fragment.split(/\s+/).filter((w) => kaal(w)) : [];
      const eersteDeel = !uit.some((x) => x !== seg && Math.floor(x.volgorde) === Math.floor(seg.volgorde) && x.volgorde < seg.volgorde);
      const laatsteDeel = !uit.some((x) => x !== seg && Math.floor(x.volgorde) === Math.floor(seg.volgorde) && x.volgorde > seg.volgorde);
      const bijStart = doorlopendVoor ? null : woordOnder(bronWoorden, seg.start);
      if (bijStart) {
        // Nooit half: het hele woord mee als het bij dit fragment hoort,
        // anders het hele woord eruit.
        const volgend = bronWoorden.find((w) => w.s >= bijStart.e - 0.01 && w !== bijStart) ?? null;
        const kant = kantVanWoord(bijStart, seg.start, eersteDeel ? woordenFragment.slice(0, 3) : [], volgend, 'start');
        const nieuw = kant === 'mee' ? bijStart.s : bijStart.e;
        ingrepen.push({
          volgorde: seg.volgorde,
          regel: 'woordgrens',
          wat: `start ${seg.start.toFixed(2)} lag in "${bijStart.w}" → ${nieuw.toFixed(2)} (${kant === 'mee' ? 'woord mee' : 'hoort bij de vorige zin'})`,
        });
        verzetGrens(seg, { start: nieuw });
      }

      const bijEind = doorlopendNa ? null : woordOnder(bronWoorden, seg.end);
      if (bijEind) {
        const vorig = [...bronWoorden].reverse().find((w) => w.e <= bijEind.s + 0.01 && w !== bijEind) ?? null;
        const kant = kantVanWoord(bijEind, seg.end, laatsteDeel ? woordenFragment.slice(-3).reverse() : [], vorig, 'eind');
        const nieuw = kant === 'mee' ? bijEind.e : bijEind.s;
        ingrepen.push({
          volgorde: seg.volgorde,
          regel: 'woordgrens',
          wat: `eind ${seg.end.toFixed(2)} lag in "${bijEind.w}" → ${nieuw.toFixed(2)} (${kant === 'mee' ? 'woord mee' : 'hoort bij de volgende zin'})`,
        });
        verzetGrens(seg, { end: nieuw });
      }
    }
  }

  // Regel 1b: ademruimte. Een knip die exact op de woordgrens ligt klinkt
  // afgebeten — de aanzet van een medeklinker begint een fractie vóór het
  // woord en de klank sterft er een fractie ná uit. We schuiven daarom naar
  // buiten, maar nooit verder dan de helft van de werkelijke stilte tot het
  // buurwoord: zo komt er nooit een stukje van een ander woord mee.
  if (bronWoorden && bronWoorden.length > 0) {
    const ADEM_VOOR = instelling('POORT_ADEM_VOOR');
    const ADEM_NA = instelling('POORT_ADEM_NA');
    // Doorlopende naden (camerawissel of sprekerwissel binnen één stuk bron:
    // het vorige deel eindigt exact waar dit begint) vóór het oprekken
    // vastleggen: daar hoort geen ademruimte, anders overlappen de delen,
    // dupliceert de poort ze en valt de helft van het shot weg.
    const doorVoor = uit.map((seg, i) => i > 0 && Math.abs(uit[i - 1].end - seg.start) < 0.005);
    const doorNa = uit.map((seg, i) => i + 1 < uit.length && Math.abs(uit[i + 1].start - seg.end) < 0.005);
    for (const [i, seg] of uit.entries()) {
      const vorig = [...bronWoorden].reverse().find((w) => w.e <= seg.start + 0.02);
      const gatVoor = vorig ? Math.max(0, seg.start - vorig.e) : 1;
      // Een strakke kant (retentieknip) heeft zijn rest-stilte al: ademruimte
      // erbij zou de weggeknipte pauze per poortronde laten teruggroeien, en
      // bij een kaderwissel in doorlopende spraak het buursegment overlappen.
      if (!seg.strakBegin && !doorVoor[i]) seg.start = Math.max(0, seg.start - Math.min(ADEM_VOOR, gatVoor / 2));

      const volgend = bronWoorden.find((w) => w.s >= seg.end - 0.02);
      const gatNa = volgend ? Math.max(0, volgend.s - seg.end) : 1;
      if (!seg.strakEind && !doorNa[i]) seg.end += Math.min(ADEM_NA, gatNa / 2);

      // Praat de spreker aan deze kant door, dan ís er geen stilte om mee te
      // nemen. Toch mag een woord niet abrupt stoppen — dat is precies het
      // "strak afgesneden" gevoel. We laten het beeld dan een tiende seconde
      // doorlopen ín het volgende woord en leggen daar de fade overheen: de
      // zin klinkt uit in plaats van af te breken, en van dat volgende woord
      // is niets te verstaan omdat het al wegzakt zodra het begint.
      // Doorlopen ín het buurwoord is geprobeerd en botst met de regel dat een
      // knip nooit binnen een woord valt: de poort schoof hem meteen weer
      // terug, eindeloos heen en weer. De grens blijft dus op het woord staan;
      // wat de abruptheid verzacht is de langere fade, en die kost geen inhoud.
      if (gatVoor < 0.12 && !seg.strakBegin && !doorVoor[i]) seg.zachtBegin = true;
      if (gatNa < 0.12 && !seg.strakEind && !doorNa[i]) seg.zachtEind = true;
    }
  }

  // Regel 2: geen gedeeld bronmateriaal. De latere staat op zijn plek in het
  // verhaal en blijft heel; de eerdere levert in.
  //
  // Maar inleveren mag nooit regel 0 breken. Zou het inkorten het fragment van
  // een shot halveren, dan vervalt dat shot in zijn geheel. Dat is de juiste
  // afweging: een cold open die de payoff woord voor woord herhaalt kan alleen
  // heel of niet — een halve zin als opening is precies de klacht.
  const vervallen = new Set<number>();
  for (let i = 0; i < uit.length; i++) {
    for (let j = i + 1; j < uit.length; j++) {
      const a = uit[i];
      const b = uit[j];
      if (vervallen.has(a.volgorde) || vervallen.has(b.volgorde)) continue;
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlap <= 0.15) continue;

      // Uitzondering: de tease. Een korte cold open die de payoff bewust
      // vooruit laat horen deelt per definitie bronmateriaal met die payoff —
      // dat is geen fout maar het ontwerp. Zonder deze uitzondering viel de
      // tease hier áltijd: inkorten kon niet (zelfde beginpunt als de payoff)
      // en de tweede tak eiste dat hij vóór het payoff-anker eindigde. Dus
      // verviel hij stilletjes, of — zonder woordankers — verloor de payoff
      // zijn eerste zin. De worker markeert alleen een kórte, volledige zin
      // als tease (hoogstens een paar seconden); langer dan dat is een
      // duplicaat en gaat gewoon door de regels hieronder.
      const teaseA = a.tease === true && a.end - a.start <= TEASE_MAX_DUUR;
      const teaseB = b.tease === true && b.end - b.start <= TEASE_MAX_DUUR;
      if (teaseA || teaseB) {
        ingrepen.push({
          volgorde: teaseA ? a.volgorde : b.volgorde,
          regel: 'tease',
          wat: `deelt ${overlap.toFixed(1)}s met shot ${teaseA ? b.volgorde : a.volgorde} als bewuste cold open; blijft staan`,
        });
        continue;
      }

      const magInkorten =
        a.start < b.start &&
        b.start - a.start >= 0.8 &&
        (a.ankerEind === undefined || b.start >= a.ankerEind - 0.15);

      if (magInkorten) {
        ingrepen.push({
          volgorde: a.volgorde,
          regel: 'overlap',
          wat: `liep ${overlap.toFixed(1)}s in shot ${b.volgorde}; eind → ${b.start.toFixed(2)}`,
        });
        a.end = b.start;
      } else if (b.end > a.end && b.end - a.end >= 0.8 && (b.ankerStart === undefined || a.end <= b.ankerStart + 0.15)) {
        ingrepen.push({
          volgorde: b.volgorde,
          regel: 'overlap',
          wat: `liep ${overlap.toFixed(1)}s in shot ${a.volgorde}; start → ${a.end.toFixed(2)}`,
        });
        b.start = a.end;
      } else if (a.start > b.start && a.start - b.start >= 0.8 && (b.ankerEind === undefined || a.start >= b.ankerEind - 0.15)) {
        // De eerdere (in de clip) ligt in de bron ná de latere en begint in
        // zijn staart: de latere levert die staart in. Zonder deze tak viel in
        // trainingsronde 11 de hele openingszin ("Vier jaar op rij meer") weg
        // voor 0,2 s ademruimte aan het eind van een later shot.
        ingrepen.push({
          volgorde: b.volgorde,
          regel: 'overlap',
          wat: `liep ${overlap.toFixed(1)}s in shot ${a.volgorde}; eind → ${a.start.toFixed(2)}`,
        });
        b.end = a.start;
      } else {
        // Niet in te korten zonder een zin te halveren: de eerdere vervalt.
        vervallen.add(a.volgorde);
        ingrepen.push({
          volgorde: a.volgorde,
          regel: 'overlap',
          wat: `dupliceert shot ${b.volgorde} en is niet in te korten zonder de zin te halveren; vervalt`,
        });
      }
    }
  }
  uit = uit.filter((seg) => !vervallen.has(seg.volgorde));

  // Regel 3: geldige lengte. Een segment dat door de regels hierboven te kort
  // werd, hoort er niet te zijn — dat is beter dan een flits van een halve
  // lettergreep.
  const minSegment = instelling('POORT_MIN_SEGMENT');
  const geldig = uit.filter((seg) => {
    if (seg.end - seg.start >= minSegment) return true;
    ingrepen.push({
      volgorde: seg.volgorde,
      regel: 'ongeldig',
      wat: `${(seg.end - seg.start).toFixed(2)}s over na de regels; segment vervalt`,
    });
    return false;
  });
  uit = geldig;

  return { segmenten: uit, ingrepen };
}
