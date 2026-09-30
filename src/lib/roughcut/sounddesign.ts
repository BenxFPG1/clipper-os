import { instelling } from './instellingen';
import type { Shot, SfxPlek } from './index';
import type { BronWoord } from './woorden';

/**
 * Sound design en natuurlijke naden — spaarzaam, gericht en mechanisch.
 *
 * De edit-agent koos per shot een sfx, en de render zette die op het begin
 * van dat shot: een whoosh op elke knip klinkt als een template. Een editor
 * gebruikt geluid om de structuur te dragen, niet om te versieren:
 *
 *  - een riser die de 1–1,5 s vóór de onthulling opbouwt, een impact op het
 *    payoff-woord (met een korte "hit"-zoom in beeld);
 *  - een ding onder een kaart met een getal;
 *  - een whoosh alleen op een kaderwissel of een kaart die binnenkomt;
 *  - nooit meer dan één effect per SFX_MIN_AFSTAND seconden (behalve riser +
 *    impact, die samen één gebaar zijn), laag onder de stem;
 *  - wat de edit-agent per shot voorstelde (shot.sfx) alleen waar de vaste
 *    regels ruimte laten.
 *
 * En de naden: bij een wissel naar ander materiaal mag het geluid een fractie
 * voor- of na-ijlen (J- of L-cut) — alleen over stilte, zodat er nooit een
 * woord dubbel of half klinkt.
 */

type Kaart = { start: number; end: number; tekst?: string };

/** In renderorde (de render sorteert op volgorde); de objecten blijven dezelfde. */
const inVolgorde = (segmenten: Shot[]) => [...segmenten].sort((a, b) => a.volgorde - b.volgorde);

function tijdlijnBegin(segmenten: Shot[]): number[] {
  const begin: number[] = [];
  let t = 0;
  for (const s of segmenten) {
    begin.push(t);
    t += s.end - s.start;
  }
  return begin;
}

/** Het eerste woord van de payoff: tijdlijnmoment en het segment waarin het valt. */
export function payoffMoment(alle: Shot[], woorden?: BronWoord[] | null): { t: number; seg: Shot; rel: number } | null {
  const segmenten = inVolgorde(alle);
  const i = segmenten.findIndex((s) => s.functie === 'payoff' && !s.tease);
  if (i < 0) return null;
  const seg = segmenten[i];
  const begin = tijdlijnBegin(segmenten)[i];
  const eerste = (woorden ?? []).find((w) => (w.s + w.e) / 2 >= seg.start && w.s <= seg.end);
  const rel = eerste ? Math.max(0, eerste.s - seg.start) : 0.05;
  return { t: begin + rel, seg, rel };
}

/** Zet de hit-zoom op het payoff-woord (muteert het segment). */
export function zetHit(segmenten: Shot[], woorden?: BronWoord[] | null): number | null {
  const p = payoffMoment(segmenten, woorden);
  if (!p) return null;
  p.seg.hit = Math.round(p.rel * 1000) / 1000;
  return p.t;
}

/**
 * Het sfx-plan voor een clip. `kaarten`: wat er als kaart binnenkomt (na de
 * hook), met tekst — een kaart met een getal krijgt een ding.
 */
export function planSfx(
  alle: Shot[],
  opties: { woorden?: BronWoord[] | null; kaarten?: Kaart[]; hookTot?: number } = {},
): SfxPlek[] {
  const segmenten = inVolgorde(alle);
  const begin = tijdlijnBegin(segmenten);
  const duur = segmenten.reduce((t, s) => t + (s.end - s.start), 0);
  const volume = instelling('SFX_VOLUME');
  type Kandidaat = SfxPlek & { prio: number; gebaar?: string };
  const kandidaten: Kandidaat[] = [];

  const p = payoffMoment(segmenten, opties.woorden);
  if (p && p.t > 1.6) {
    kandidaten.push({ slug: 'impact', t: Math.max(0, p.t - 0.02), volume: volume * 1.25, prio: 1, reden: 'payoff-woord', gebaar: 'payoff' });
    kandidaten.push({ slug: 'riser', t: Math.max(0, p.t - 1.4), volume: volume * 0.8, prio: 2, reden: 'opbouw naar de onthulling', gebaar: 'payoff' });
  }
  for (const k of opties.kaarten ?? []) {
    if (k.start < (opties.hookTot ?? 0) + 0.2 || k.start > duur - 0.5) continue;
    const getal = /\d/.test(k.tekst ?? '');
    kandidaten.push({ slug: getal ? 'ding' : 'whoosh', t: Math.max(0, k.start - (getal ? 0 : 0.12)), volume: getal ? volume : volume * 0.8, prio: getal ? 3 : 4, reden: getal ? 'kaart met getal' : 'kaart in' });
  }
  segmenten.forEach((s, i) => {
    if (i === 0 || !s.zachteWissel) return;
    kandidaten.push({ slug: 'whoosh', t: Math.max(0, begin[i] - 0.12), volume: volume * 0.7, prio: 5, reden: 'kaderwissel' });
  });
  // Voorstellen van de edit-agent (shot.sfx) tellen mee als laatste keus:
  // ze krijgen alleen een plek als de vaste regels daar ruimte laten. Niet
  // in de hook (daar staat de hookkaart), niet op het payoff-shot (dat heeft
  // zijn impact al) en niet als 'stilte' — dat is een muziekinstructie.
  segmenten.forEach((s, i) => {
    const slug = s.sfx;
    if (!slug || slug === 'geen' || slug === 'stilte' || s.functie === 'payoff' || s.tease) return;
    if (begin[i] < (opties.hookTot ?? 0) + 0.2) return;
    kandidaten.push({ slug, t: begin[i], volume: volume * 0.8, prio: 6, reden: 'voorstel edit-agent' });
  });

  // Spaarzaam: op prioriteit, hoogstens één effect per SFX_MIN_AFSTAND;
  // riser en impact van hetzelfde gebaar mogen samen.
  const afstand = instelling('SFX_MIN_AFSTAND');
  const gekozen: Kandidaat[] = [];
  for (const k of [...kandidaten].sort((a, b) => a.prio - b.prio || a.t - b.t)) {
    const botst = gekozen.some((g) => Math.abs(g.t - k.t) < afstand && !(g.gebaar && g.gebaar === k.gebaar));
    if (!botst) gekozen.push(k);
  }
  return gekozen
    .sort((a, b) => a.t - b.t)
    .map(({ slug, t, volume: v, reden }) => ({ slug, t: Math.round(t * 1000) / 1000, volume: Math.round((v ?? volume) * 1000) / 1000, reden }));
}

/**
 * J/L-cuts op de naden naar ander materiaal. Een J-cut (het volgende geluid
 * begint JL_DUUR eerder) als de volgende spreker direct begint te praten —
 * je hoort hem vóór je hem ziet; anders een L-cut (het vorige geluid loopt
 * door onder het nieuwe beeld). Alleen als het verschoven stuk aan béide
 * kanten stil is: dan klinkt er geen woord dubbel of half. Muteert
 * `audioNaad`; levert per naad wat er gebeurde.
 */
export function planJL(alle: Shot[], woorden: BronWoord[] | null): { naad: number; soort: 'J' | 'L' }[] {
  const segmenten = inVolgorde(alle);
  for (const s of segmenten) s.audioNaad = undefined;
  const uit: { naad: number; soort: 'J' | 'L' }[] = [];
  if (!woorden || woorden.length === 0) return uit;
  const d = instelling('JL_DUUR');
  const stil = (van: number, tot: number) => !woorden.some((w) => w.e > van + 0.02 && w.s < tot - 0.02);
  for (let i = 0; i + 1 < segmenten.length; i++) {
    const a = segmenten[i];
    const b = segmenten[i + 1];
    // Alleen een echte wissel naar ander materiaal; een pauzeknip of een
    // kaderwissel binnen doorlopende spraak heeft geen tweede geluid.
    if (b.strakBegin || Math.abs(b.start - a.end) < 0.3 || a.tease || b.tease) continue;
    const eersteWoordB = woorden.find((w) => (w.s + w.e) / 2 >= b.start && w.s <= b.end);
    const praatMeteen = eersteWoordB ? eersteWoordB.s - b.start < 0.3 : false;
    const kanJ = stil(a.end - d, a.end) && stil(b.start - d, b.start);
    const kanL = stil(a.end, a.end + d) && stil(b.start, b.start + d);
    const keuze = praatMeteen ? (kanJ ? 'J' : kanL ? 'L' : null) : kanL ? 'L' : kanJ ? 'J' : null;
    if (!keuze) continue;
    a.audioNaad = keuze === 'J' ? -d : d;
    uit.push({ naad: i, soort: keuze });
  }
  return uit;
}
