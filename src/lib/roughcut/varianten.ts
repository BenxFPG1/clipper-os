import type { Shot } from './index';

export type ClipVariant = {
  /** Achtervoegsel voor de sequencenaam, bv. "kort skelet". */
  naam: string;
  /** Wat de editor moet weten om deze versie af te maken. */
  toelichting: string;
  shots: Shot[];
};

/**
 * Maakt extra montagevarianten uit de shots die er al liggen — zonder ook maar
 * één AI-call. Het plan levert per clip één uitgewerkte volgorde; deze
 * recombinaties zijn puur mechanisch en leveren per clip drie tot vier
 * publiceerbare versies in plaats van één.
 *
 * De aanpakken komen overeen met de varianten die de planner zelf benoemt:
 * korter maken, later instappen, of afbreken vóór de payoff.
 */
export function maakVarianten(shots: Shot[]): ClipVariant[] {
  const gesorteerd = [...shots].sort((a, b) => a.volgorde - b.volgorde).filter((s) => s.end > s.start);
  if (gesorteerd.length < 3) return [];

  const varianten: ClipVariant[] = [];
  const hernummer = (lijst: Shot[]): Shot[] => lijst.map((s, i) => ({ ...s, volgorde: i + 1 }));

  const hook = gesorteerd.find((s) => s.functie === 'hook') ?? gesorteerd[0];
  const payoff = [...gesorteerd].reverse().find((s) => s.functie === 'payoff');
  const barst = gesorteerd.find((s) => s.functie === 'barst');
  const midden = gesorteerd.filter((s) => s !== hook && s !== payoff);

  // 1. Kort skelet: alleen de dragende beats. Korte clips worden vaker
  //    afgekeken, en afkijkratio weegt zwaar in de distributie.
  if (payoff && gesorteerd.length > 3) {
    const kern = [hook, barst, payoff].filter((s): s is Shot => Boolean(s));
    const uniek = kern.filter((s, i) => kern.indexOf(s) === i);
    if (uniek.length >= 2 && uniek.length < gesorteerd.length) {
      varianten.push({
        naam: 'kort skelet',
        toelichting: 'Alleen hook, barst en payoff. Sneller, hogere kans dat hij wordt afgekeken.',
        shots: hernummer(uniek),
      });
    }
  }

  // 2. Ander anker: begin op de barst (in medias res), reconstrueer daarna.
  //    Zelfde materiaal, ander instappunt — geen re-upload van dezelfde edit.
  if (barst && barst !== hook) {
    const rest = gesorteerd.filter((s) => s !== barst);
    varianten.push({
      naam: 'ander anker',
      toelichting:
        'Start op de barst, daarna de opbouw. Gebruik de tweede hooktekst uit het plan als overlay.',
      shots: hernummer([barst, ...rest]),
    });
  }

  // 3. Part 1: afbreken vlak vóór de payoff. Werkt als de payoff sterk genoeg
  //    is om er een tweede post van te maken; de comments doen de rest.
  if (payoff) {
    const index = gesorteerd.indexOf(payoff);
    const deel1 = gesorteerd.slice(0, index);
    if (deel1.length >= 2) {
      varianten.push({
        naam: 'part 1 (cliffhanger)',
        toelichting: 'Stopt vóór de payoff. Post de payoff als part 2 zodra dit deel aanslaat.',
        shots: hernummer(deel1),
      });
      varianten.push({
        naam: 'part 2 (de payoff)',
        toelichting: 'Begint bij het moment vlak vóór de onthulling. Alleen posten na part 1.',
        shots: hernummer([...(barst && barst !== payoff ? [barst] : midden.slice(-1)), payoff]),
      });
    }
  }

  return varianten;
}
