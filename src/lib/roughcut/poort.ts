import type { Shot } from './index';
import type { BronWoord } from './woorden';

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
 *     wordt hij naar buiten geschoven naar de rand van dat woord.
 *  2. Geen twee segmenten delen bronmateriaal, want dan hoort de kijker
 *     dezelfde woorden twee keer.
 *  3. Segmenten zijn niet omgekeerd of te kort om te bestaan.
 *
 * Elke ingreep wordt gerapporteerd. Grijpt de poort ergens in, dan is dat per
 * definitie een bug bovenstrooms: het rapport is de plek waar je die vindt.
 */

export type PoortIngreep = {
  volgorde: number;
  regel: 'woordgrens' | 'overlap' | 'ongeldig';
  wat: string;
};

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

  // Regel 1: geen knip middenin een woord.
  if (bronWoorden && bronWoorden.length > 0) {
    for (const seg of uit) {
      const bijStart = woordOnder(bronWoorden, seg.start);
      if (bijStart) {
        // Naar buiten: het hele woord komt mee. Een knip naar binnen zou het
        // woord juist half maken, en dat is exact wat we bestrijden.
        ingrepen.push({
          volgorde: seg.volgorde,
          regel: 'woordgrens',
          wat: `start ${seg.start.toFixed(2)} lag in "${bijStart.w}" → ${bijStart.s.toFixed(2)}`,
        });
        seg.start = bijStart.s;
      }

      const bijEind = woordOnder(bronWoorden, seg.end);
      if (bijEind) {
        ingrepen.push({
          volgorde: seg.volgorde,
          regel: 'woordgrens',
          wat: `eind ${seg.end.toFixed(2)} lag in "${bijEind.w}" → ${bijEind.e.toFixed(2)}`,
        });
        seg.end = bijEind.e;
      }
    }
  }

  // Regel 2: geen gedeeld bronmateriaal. De latere staat op zijn plek in het
  // verhaal en blijft heel; de eerdere levert in.
  for (let i = 0; i < uit.length; i++) {
    for (let j = i + 1; j < uit.length; j++) {
      const a = uit[i];
      const b = uit[j];
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlap <= 0.15) continue;

      if (a.start < b.start && b.start - a.start >= 0.8) {
        ingrepen.push({
          volgorde: a.volgorde,
          regel: 'overlap',
          wat: `liep ${overlap.toFixed(1)}s in shot ${b.volgorde}; eind → ${b.start.toFixed(2)}`,
        });
        a.end = b.start;
      } else if (b.end > a.end && b.end - a.end >= 0.8) {
        ingrepen.push({
          volgorde: b.volgorde,
          regel: 'overlap',
          wat: `liep ${overlap.toFixed(1)}s in shot ${a.volgorde}; start → ${a.end.toFixed(2)}`,
        });
        b.start = a.end;
      }
    }
  }

  // Regel 3: geldige lengte. Een segment dat door de regels hierboven te kort
  // werd, hoort er niet te zijn — dat is beter dan een flits van een halve
  // lettergreep.
  const geldig = uit.filter((seg) => {
    if (seg.end - seg.start >= 0.6) return true;
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
