import type { EditDoelen } from '../vault/normen';
import { basisZoom, type Shot } from './index';
import { instelling } from './instellingen';
import { groepeerRegels, woordenOpTijdlijn } from './ondertitels';
import { verzetGrens, woordOnder } from './poort';
import type { KeuringRegel } from './keuring';
import type { BronWoord } from './woorden';

/**
 * Retentie-editing: per halve seconde voorspellen waar de kijker afhaakt, en
 * dáár ingrijpen.
 *
 * Waarom dit bestaat: tot nu toe zaten de ingrepen op vaste plekken — een
 * punch-in op elke naad, een kaart bij een tijdsprong, een re-hook op de
 * seconde die de planner ooit noemde. Wat een kijker laat wegswipen is
 * daarentegen héél lokaal en meetbaar: een adempauze van een seconde, vijf
 * seconden hetzelfde beeld, een regel zonder tekst, een aanloop vol "eh" en
 * "zeg maar", en vooral: lang wachten op iets dat nog moet komen. Dat staat
 * allemaal al in de woordtijden en in het montageplan; je hoeft het alleen op
 * te tellen.
 *
 * Deze module doet drie dingen, allemaal deterministisch (geen model):
 *
 *  1. meten: een risicocurve per `RETENTIE_STAP` seconde op de tijdlijn, plus
 *     de harde maten (eerste wissel, langste beeldgat, langste tekstgat,
 *     resterende pauzes) waar de keuring op toetst;
 *  2. ingrijpen: pauzes boven het doel weg als jump-cut op woordgrenzen,
 *     kaderwissels (afwisselend punch-in en terug) waar het beeld te lang
 *     stilstaat, de eerste wissel vóór `eersteKnipMaxS`, en één re-hookkaart
 *     in het grootste risicogat vóór de payoff;
 *  3. rapporteren: voor/na, doelen en elke ingreep, voor het montageplan.
 *
 * De doelen komen uit editDoelen() — wat top-clips van anderen meetbaar doen —
 * niet uit een gevoel. De ingrepen gaan vóór de kadercontrole en de poort, dus
 * alles wat hier gebeurt wordt daarna gewoon door dezelfde regels getoetst.
 * Bewust ook geen ingrepen in de tease: een cold open is heel of niet.
 */

export type Kaart = { start: number; end: number; tekst?: string };

export type RetentieContext = {
  bronWoorden: BronWoord[] | null;
  doelen: EditDoelen;
  /**
   * Kaarten die al vastliggen op de tijdlijn (hook, context, uitvalrisico's).
   * Kaarten die aan een shot hangen (tekstkaart) rekent de module zelf mee.
   */
  kaarten?: Kaart[];
  /** Staan er woordelijke ondertitels in beeld? Dan telt gesproken tekst als tekst in beeld. */
  ondertitels?: boolean;
};

export type RetentieMeting = {
  duur: number;
  stap: number;
  /** Risico 0..1 per stap vanaf t=0. */
  curve: number[];
  /** Eerste visuele verandering (s); null als het beeld de hele clip stilstaat. */
  eersteWissel: number | null;
  wissels: number;
  wisselsPer10s: number;
  /** Langste stuk zonder visuele verandering ná de eerste wissel (s), en waar het begint. */
  maxGatBeeld: number;
  maxGatBeeldOp: number;
  /** Langste stuk zonder tekst in beeld (s); null als er niets over tekst te zeggen valt (geen woorden). */
  maxGatTekst: number | null;
  /** Pauzes in spraak boven het doel (payoff-pauzes tot het payoff-maximum tellen niet). */
  pauzes: number;
  pauzeSeconden: number;
  gemiddeldRisico: number;
  /** De drie hoogste pieken, minstens twee seconden uit elkaar, met de reden. */
  knelpunten: { t: number; risico: number; waarom: string; volgorde: number }[];
  /** Woorden gemeten? Zonder woordtijden zijn pauzes en tekst niet te toetsen. */
  metWoorden: boolean;
};

export type RetentieIngreep = {
  soort: 'pauze' | 'wissel' | 'eerste_wissel' | 'rehook' | 'overgeslagen';
  volgorde: number;
  /** Brontijd van de knip (s). */
  bron?: number;
  /** Plek op de tijdlijn vóór de ingreep (s). */
  tijdlijn?: number;
  wat: string;
};

export type RetentieResultaat = {
  segmenten: Shot[];
  doelen: EditDoelen;
  voor: RetentieMeting;
  na: RetentieMeting;
  ingrepen: RetentieIngreep[];
  rehook: Kaart | null;
  logregel: string;
};

// ------------------------------------------------------------------ helpers

/** Woorden die geen informatie dragen: aanloop, twijfel, opvulling. */
const OPVULLING = new Set(['eh', 'ehm', 'euh', 'uh', 'uhm', 'um', 'hm', 'hmm', 'nou', 'gewoon', 'eigenlijk', 'enzo', 'hè']);
/** Tweewoordsopvulling: pas opvulling als het woord ervóór klopt ("zeg maar", "weet je"). */
const OPVULLING_PAREN = new Set(['zeg maar', 'weet je', 'ik bedoel', 'you know', 'i mean']);
/** Te kort of te gewoon om als "herhaling" te tellen. */
const STOPWOORDEN = new Set([
  'de', 'het', 'een', 'en', 'van', 'dat', 'die', 'dit', 'in', 'op', 'is', 'te', 'met', 'voor', 'niet', 'aan',
  'er', 'ook', 'als', 'bij', 'wat', 'nog', 'naar', 'wel', 'dan', 'ze', 'hij', 'zij', 'we', 'wij', 'ik', 'jij',
  'zijn', 'was', 'heb', 'heeft', 'hebben', 'kan', 'om', 'maar', 'want', 'of', 'the', 'and', 'that', 'this',
]);

const schoon = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const nl = (n: number) => n.toFixed(1).replace('.', ',');
const rond = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Index van het eerste woord dat na `t` eindigt (binair zoeken; de lijst is oplopend). */
function vanafIndex(woorden: BronWoord[], t: number): number {
  let lo = 0;
  let hi = woorden.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (woorden[mid].e < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** De woorden die (met hun midden) binnen een bronvenster vallen. */
function woordenIn(woorden: BronWoord[], van: number, tot: number): BronWoord[] {
  const uit: BronWoord[] = [];
  for (let k = vanafIndex(woorden, van - 1); k < woorden.length; k++) {
    const w = woorden[k];
    if (w.s > tot) break;
    const mid = (w.s + w.e) / 2;
    if (mid >= van && mid <= tot) uit.push(w);
  }
  return uit;
}

type TijdlijnWoord = { w: string; s: number; e: number; seg: number };

function tijdlijnWoorden(segmenten: Shot[], woorden: BronWoord[]): TijdlijnWoord[] {
  const uit: TijdlijnWoord[] = [];
  let cursor = 0;
  segmenten.forEach((seg, i) => {
    const duur = seg.end - seg.start;
    for (const w of woordenIn(woorden, seg.start, seg.end)) {
      uit.push({
        w: w.w,
        s: cursor + Math.max(0, w.s - seg.start),
        e: cursor + Math.min(duur, Math.max(w.e - seg.start, w.s - seg.start + 0.05)),
        seg: i,
      });
    }
    cursor += duur;
  });
  return uit;
}

/** Begintijden van de segmenten op de tijdlijn, plus de totale duur. */
function tijdlijn(segmenten: Shot[]): { begin: number[]; duur: number } {
  const begin: number[] = [];
  let cursor = 0;
  for (const seg of segmenten) {
    begin.push(cursor);
    cursor += seg.end - seg.start;
  }
  return { begin, duur: cursor };
}

/** Kaarten die aan een shot hangen, op dezelfde plek als maakTekstkaarten ze zet. */
function segmentKaarten(segmenten: Shot[]): Kaart[] {
  const uit: Kaart[] = [];
  let cursor = 0;
  for (const seg of segmenten) {
    const duur = seg.end - seg.start;
    if (!seg.subKnip && (seg.tekstkaart || seg.beeld_effect === 'tekstkaart')) {
      uit.push({ start: cursor, end: cursor + Math.min(2.2, Math.max(1.2, duur)), tekst: seg.tekstkaart ?? undefined });
    }
    cursor += duur;
  }
  return uit;
}

const ZICHTBARE_EFFECTEN = new Set(['punch_in', 'snelle_zoom', 'shake', 'flits_wit', 'zwart_frame', 'freeze_frame']);

/**
 * Alle momenten waarop het beeld zichtbaar verandert: een knip naar ander
 * materiaal, een naad met ander kader (zoom of focus), een beeldingreep, en
 * het opkomen of wegvallen van een kaart. Een naad binnen doorlopend
 * materiaal zónder kaderverschil telt níet — dat ziet de kijker niet.
 */
export function wisselMomenten(segmenten: Shot[], kaarten: Kaart[] = []): number[] {
  const minVerschil = instelling('ZOOM_NAAD_MIN_VERSCHIL');
  const { begin, duur } = tijdlijn(segmenten);
  const t: number[] = [];
  segmenten.forEach((seg, i) => {
    if (i === 0) return;
    const vorige = segmenten[i - 1];
    const aansluitend = Math.abs(seg.start - vorige.end) <= 0.05;
    const zoomVerschil = Math.abs((seg.zoom ?? basisZoom(seg)) - (vorige.zoom ?? basisZoom(vorige)));
    const focusVerschil = Math.abs((seg.focusX ?? 0.5) - (vorige.focusX ?? 0.5));
    const effect = ZICHTBARE_EFFECTEN.has(seg.beeld_effect ?? '');
    if (!aansluitend || zoomVerschil >= minVerschil - 1e-6 || focusVerschil > 0.1 || effect) t.push(begin[i]);
  });
  for (const k of [...kaarten, ...segmentKaarten(segmenten)]) {
    if (k.start > 0.3 && k.start < duur - 0.1) t.push(k.start);
    if (k.end > 0.3 && k.end < duur - 0.1) t.push(k.end);
  }
  return [...new Set(t.map((x) => rond(x, 2)))].sort((a, b) => a - b);
}

/** Vensters met tekst in beeld: kaarten, en bij ondertitels elke regel. */
function tekstVensters(segmenten: Shot[], woorden: BronWoord[] | null, kaarten: Kaart[], ondertitels: boolean): Kaart[] {
  const vensters: Kaart[] = [...kaarten, ...segmentKaarten(segmenten)].map((k) => ({ start: k.start, end: k.end }));
  if (ondertitels && woorden && woorden.length > 0) {
    for (const r of groepeerRegels(woordenOpTijdlijn(segmenten, woorden))) vensters.push({ start: r.s, end: r.e });
  }
  vensters.sort((a, b) => a.start - b.start);
  const samen: Kaart[] = [];
  for (const v of vensters) {
    const laatste = samen[samen.length - 1];
    if (laatste && v.start <= laatste.end + 0.02) laatste.end = Math.max(laatste.end, v.end);
    else samen.push({ ...v });
  }
  return samen;
}

type Pauze = { van: number; tot: number; seg: number; toegestaan: boolean };

/**
 * Mag deze pauze blijven staan? Alleen in de eerste seconden van een
 * payoff-shot, rond de onthulling: daar is stilte spanning. Verderop in
 * hetzelfde shot is het gewoon een pauze.
 */
function payoffPauze(seg: Shot | undefined, sindsShotStart: number, gat: number, maxPauze: number): boolean {
  if (seg?.functie !== 'payoff') return false;
  if (sindsShotStart > instelling('RETENTIE_PAYOFF_VENSTER')) return false;
  return gat <= Math.max(maxPauze, instelling('RETENTIE_PAYOFF_PAUZE_MAX'));
}

/** Pauzes op de tijdlijn tussen twee woorden binnen hetzelfde segment, langer dan het doel. */
function pauzesOpTijdlijn(tw: TijdlijnWoord[], segmenten: Shot[], maxPauze: number): Pauze[] {
  const { begin } = tijdlijn(segmenten);
  const uit: Pauze[] = [];
  for (let i = 0; i + 1 < tw.length; i++) {
    const a = tw[i];
    const b = tw[i + 1];
    // Over een naad heen is het geen pauze in de spraak maar een knip; de
    // ademruimte daar is werk van de poort.
    if (a.seg !== b.seg) continue;
    const gat = b.s - a.e;
    if (gat <= maxPauze) continue;
    uit.push({ van: a.e, tot: b.s, seg: a.seg, toegestaan: payoffPauze(segmenten[a.seg], a.e - begin[a.seg], gat, maxPauze) });
  }
  return uit;
}

// ------------------------------------------------------------------ meten

/** Meet de risicocurve en de harde retentiematen van een montage (segmenten in volgorde). */
export function meetRetentie(segmenten: Shot[], ctx: RetentieContext): RetentieMeting {
  const stap = instelling('RETENTIE_STAP');
  const { doelen } = ctx;
  const kaarten = ctx.kaarten ?? [];
  const { begin, duur } = tijdlijn(segmenten);
  const woorden = ctx.bronWoorden && ctx.bronWoorden.length > 0 ? ctx.bronWoorden : null;
  const tw = woorden ? tijdlijnWoorden(segmenten, woorden) : [];

  const wissels = wisselMomenten(segmenten, kaarten);
  const tekst = tekstVensters(segmenten, woorden, kaarten, ctx.ondertitels !== false);
  const pauzes = woorden ? pauzesOpTijdlijn(tw, segmenten, doelen.maxPauzeS) : [];

  // Het eerste stuk heeft een eigen, strakkere norm (eersteKnipMaxS); de
  // gaten daarna worden tegen maxSecondenZonderVisueleVerandering gelegd.
  const eersteWissel = wissels.length > 0 ? wissels[0] : null;
  const grenzen = [...wissels, duur];
  let maxGatBeeld = 0;
  let maxGatBeeldOp = eersteWissel ?? 0;
  for (let i = 0; i + 1 < grenzen.length; i++) {
    const gat = grenzen[i + 1] - grenzen[i];
    if (gat > maxGatBeeld) {
      maxGatBeeld = gat;
      maxGatBeeldOp = grenzen[i];
    }
  }
  if (eersteWissel === null) maxGatBeeld = duur;

  let maxGatTekst: number | null = null;
  if (woorden || tekst.length > 0) {
    let vorigEind = 0;
    maxGatTekst = 0;
    for (const v of tekst) {
      maxGatTekst = Math.max(maxGatTekst, v.start - vorigEind);
      vorigEind = Math.max(vorigEind, v.end);
    }
    maxGatTekst = Math.max(maxGatTekst, duur - vorigEind);
  }

  // Waar de payoff begint: daarnaar toe groeit het "wachten"-risico. De tease
  // telt niet; die laat de payoff alleen vooruit horen.
  const payoffIndex = (() => {
    const p = segmenten.findIndex((s) => s.functie === 'payoff' && !s.tease);
    return p >= 0 ? p : segmenten.findIndex((s) => s.functie === 'barst' && !s.tease);
  })();
  const payoffStart = payoffIndex >= 0 ? begin[payoffIndex] : null;

  const wP = instelling('RETENTIE_W_PAUZE');
  const wB = instelling('RETENTIE_W_BEELD');
  const wT = instelling('RETENTIE_W_TEKST');
  const wL = instelling('RETENTIE_W_LEEG');
  const wY = instelling('RETENTIE_W_PAYOFF');
  const eersteS = instelling('RETENTIE_EERSTE_SECONDEN');
  const eersteGewicht = instelling('RETENTIE_EERSTE_GEWICHT');
  const horizon = instelling('RETENTIE_PAYOFF_HORIZON');

  // Eén keer vooraf: welke inhoudswoorden zijn al eens gevallen? Een zin die
  // alleen herhaalt wat er al gezegd is, voegt niets toe.
  const herhaald = new Array<boolean>(tw.length).fill(false);
  const opvulling = new Array<boolean>(tw.length).fill(false);
  {
    const gezien = new Map<string, number>();
    tw.forEach((w, i) => {
      const n = schoon(w.w);
      const vorige = i > 0 ? schoon(tw[i - 1].w) : '';
      // Een los "eh", een woordpaar als "zeg maar", of een directe herhaling
      // ("ik ik", "de de"): allemaal seconden zonder nieuwe informatie.
      const paar = OPVULLING_PAREN.has(`${vorige} ${n}`);
      if (paar && i > 0) opvulling[i - 1] = true;
      opvulling[i] = OPVULLING.has(n) || paar || (n.length > 0 && vorige === n);
      if (n.length >= 4 && !STOPWOORDEN.has(n)) {
        const eerder = gezien.get(n);
        if (eerder !== undefined && w.s - eerder < 25) herhaald[i] = true;
        gezien.set(n, w.s);
      }
    });
  }

  const curve: number[] = [];
  const componenten: { pauze: number; beeld: number; tekst: number; leeg: number; payoff: number }[] = [];
  for (let t = 0; t < duur - 1e-6; t += stap) {
    const m = Math.min(duur, t + stap / 2);

    const pauze = pauzes.some((p) => !p.toegestaan && m >= p.van && m <= p.tot) ? 1 : 0;

    const laatsteWissel = [...wissels].reverse().find((w) => w <= m);
    const beeldNorm = laatsteWissel === undefined ? doelen.eersteKnipMaxS : doelen.maxSecondenZonderVisueleVerandering;
    const sindsBeeld = m - (laatsteWissel ?? 0);
    const beeld = Math.min(1.5, sindsBeeld / Math.max(0.1, beeldNorm)) / 1.5;

    const inTekst = tekst.some((v) => m >= v.start && m <= v.end);
    const vorigeTekst = [...tekst].reverse().find((v) => v.end <= m);
    const sindsTekst = inTekst ? 0 : m - (vorigeTekst?.end ?? 0);
    const tekstRisico = woorden || tekst.length > 0 ? Math.min(1.5, sindsTekst / Math.max(0.1, doelen.maxSecondenZonderTekst)) / 1.5 : 0;

    let leeg = 0;
    if (tw.length > 0) {
      let n = 0;
      let dood = 0;
      tw.forEach((w, i) => {
        if (w.s < m - 1.5 || w.s > m + 1.5) return;
        n++;
        if (opvulling[i] || herhaald[i]) dood++;
      });
      leeg = n > 0 ? dood / n : 0;
    }

    const payoff =
      payoffStart === null ? 0.5 : m < payoffStart ? Math.min(1, (payoffStart - m) / Math.max(1, horizon)) : 0.1;

    const ruw = wP * pauze + wB * beeld + wT * tekstRisico + wL * leeg + wY * payoff;
    const risico = Math.min(1, ruw * (m < eersteS ? eersteGewicht : 1));
    curve.push(rond(risico));
    componenten.push({ pauze: wP * pauze, beeld: wB * beeld, tekst: wT * tekstRisico, leeg: wL * leeg, payoff: wY * payoff });
  }

  // Knelpunten: de hoogste pieken, niet drie keer dezelfde.
  const knelpunten: RetentieMeting['knelpunten'] = [];
  const opVolgorde = curve.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r);
  for (const { r, i } of opVolgorde) {
    if (knelpunten.length >= 3 || r < 0.3) break;
    const t = rond(i * stap, 1);
    if (knelpunten.some((k) => Math.abs(k.t - t) < 2)) continue;
    const c = componenten[i];
    const namen: [string, number][] = [
      ['pauze', c.pauze],
      ['beeld staat stil', c.beeld],
      ['geen tekst', c.tekst],
      ['aanloop/herhaling', c.leeg],
      ['wacht op payoff', c.payoff],
    ];
    const waarom = namen
      .filter(([, v]) => v >= 0.06)
      .sort((a, b) => b[1] - a[1])
      .map(([n]) => n)
      .slice(0, 3)
      .join(' + ');
    const segIndex = begin.findIndex((b, k) => t >= b && t < b + (segmenten[k].end - segmenten[k].start));
    knelpunten.push({ t, risico: r, waarom: waarom || 'opgeteld', volgorde: segmenten[segIndex]?.volgorde ?? 0 });
  }

  const telbaar = pauzes.filter((p) => !p.toegestaan);
  return {
    duur: rond(duur),
    stap,
    curve,
    eersteWissel: eersteWissel === null ? null : rond(eersteWissel),
    wissels: wissels.length,
    wisselsPer10s: duur > 0 ? rond((wissels.length / duur) * 10, 1) : 0,
    maxGatBeeld: rond(maxGatBeeld),
    maxGatBeeldOp: rond(maxGatBeeldOp),
    maxGatTekst: maxGatTekst === null ? null : rond(maxGatTekst),
    pauzes: telbaar.length,
    pauzeSeconden: rond(telbaar.reduce((s, p) => s + (p.tot - p.van), 0)),
    gemiddeldRisico: curve.length ? rond(curve.reduce((a, b) => a + b, 0) / curve.length) : 0,
    knelpunten,
    metWoorden: Boolean(woorden),
  };
}

// ------------------------------------------------------------------ ingrijpen

type Snede = {
  /** Einde van het deel ervóór (bron). */
  x: number;
  /** Begin van het deel erna (bron); gelijk aan x bij een kaderwissel zonder weggeknipt materiaal. */
  y: number;
  soort: 'pauze' | 'wissel' | 'eerste_wissel';
};

/** Zoom van deel k: afwisselend het basiskader en een punch-in, nooit wijder dan de basis. */
function wisselZoom(basis: number, k: number): number | undefined {
  const bump = instelling('ZOOM_NAADBUMP');
  const max = instelling('ZOOM_MAX');
  const minVerschil = instelling('ZOOM_NAAD_MIN_VERSCHIL');
  const inZoom = Math.min(max, basis + bump);
  // Wijder dan de basis gaat niet: de basiszoom is vaak juist nodig om de
  // spreker te kúnnen centreren. Kan er niet ingezoomd worden, dan laten we
  // het kader aan de naadbump (pasNaadZoomToe) over.
  if (inZoom - basis < minVerschil) return undefined;
  return rond(k % 2 === 0 ? basis : inZoom, 3);
}

/**
 * Knipt een segment op de gegeven snedes in delen. Grenzen gaan via
 * verzetGrens (anders trekt de poort ze via het oude anker terug), elke
 * binnengrens is strak (geen extra ademruimte), en alleen het eerste deel
 * houdt het scriptfragment, de effecten en de kaart van het shot — de andere
 * delen zijn voortzettingen, geen nieuwe shots.
 */
function knipInDelen(seg: Shot, snedes: Snede[]): Shot[] {
  if (snedes.length === 0) return [seg];
  const gesorteerd = [...snedes].sort((a, b) => a.x - b.x);
  const basis = seg.zoom ?? basisZoom(seg);
  // Volgnummers ná het shot maar vóór een eventuele sprekerswissel-helft
  // (volgorde + 0,5): een lang shot kan tientallen delen krijgen, en een
  // botsend volgnummer laat de poort en de keuring het verkeerde deel pakken.
  const stap = 0.4 / Math.max(40, gesorteerd.length + 1);
  const delen: Shot[] = [];
  for (let k = 0; k <= gesorteerd.length; k++) {
    const van = k === 0 ? seg.start : gesorteerd[k - 1].y;
    const tot = k === gesorteerd.length ? seg.end : gesorteerd[k].x;
    const deel: Shot = { ...seg, volgorde: rond(seg.volgorde + k * stap, 4), exact: false };
    if (k > 0) {
      verzetGrens(deel, { start: van });
      deel.strakBegin = true;
      deel.zachtBegin = false;
      deel.subKnip = true;
      deel.planStart = van;
      deel.tease = false;
      deel.beeld_effect = 'geen';
      deel.sfx = 'geen';
      deel.tekstkaart = null;
      (deel as { transcript_fragment?: string }).transcript_fragment = undefined;
    }
    if (k < gesorteerd.length) {
      verzetGrens(deel, { end: tot });
      deel.strakEind = true;
      deel.zachtEind = false;
    }
    // Het spoor staat in absolute brontijd; alleen het stuk dat bij dit deel
    // hoort blijft, anders stuurt de camera op een positie uit een ander deel.
    const knipSpoor = (s?: { t: number; x: number }[]) => {
      const binnen = s?.filter((p) => p.t >= van - 0.5 && p.t <= tot + 0.5);
      return binnen && binnen.length >= 2 ? binnen : undefined;
    };
    deel.spoor = knipSpoor(seg.spoor);
    deel.spoorY = knipSpoor(seg.spoorY);
    const zoom = wisselZoom(basis, k);
    if (zoom !== undefined) deel.zoom = zoom;
    delen.push(deel);
  }
  return delen;
}

function bouwDelen(segmenten: Shot[], snedes: Map<number, Snede[]>): { delen: Shot[]; oorsprong: number[] } {
  const delen: Shot[] = [];
  const oorsprong: number[] = [];
  segmenten.forEach((seg, i) => {
    for (const d of knipInDelen(seg, snedes.get(i) ?? [])) {
      delen.push(d);
      oorsprong.push(i);
    }
  });
  return { delen, oorsprong };
}

/**
 * Past de retentie-ingrepen toe. Segmenten in montagevolgorde erin, een nieuwe
 * lijst eruit (de invoer wordt niet gewijzigd); daarnaast de meting voor en na
 * en elke ingreep met reden.
 */
export function pasRetentieToe(
  segmenten: Shot[],
  ctx: RetentieContext & {
    /** Kandidaatregels voor een re-hookkaart (uit plan of edit-agent), sterkste eerst. */
    rehookRegels?: string[];
    /** Tot waar de hookkaart in beeld staat (s); daarvóór geen re-hook. */
    hookTot?: number;
  },
): RetentieResultaat {
  const { doelen } = ctx;
  const woorden = ctx.bronWoorden && ctx.bronWoorden.length > 0 ? ctx.bronWoorden : null;
  const kaarten = ctx.kaarten ?? [];
  const voor = meetRetentie(segmenten, ctx);
  const ingrepen: RetentieIngreep[] = [];
  const minDeel = instelling('RETENTIE_MIN_DEEL');
  const rest = instelling('RETENTIE_PAUZE_REST');
  const payoffMax = Math.max(doelen.maxPauzeS, instelling('RETENTIE_PAYOFF_PAUZE_MAX'));

  const snedes = new Map<number, Snede[]>();
  const voegToe = (i: number, s: Snede) => snedes.set(i, [...(snedes.get(i) ?? []), s]);

  if (!woorden) {
    ingrepen.push({ soort: 'overgeslagen', volgorde: 0, wat: 'geen woordtijden: pauzes en kaderwissels niet op woordgrenzen te leggen' });
  }

  // 1. Pauzes weg als jump-cut. Alleen binnen een segment en tussen twee
  // woorden: de knip valt in de stilte, nooit in een woord, en er blijft een
  // rest-stilte staan zodat het nog als ademhaling klinkt. In een payoff-shot
  // mag een pauze tot het payoff-maximum blijven (dat ís de spanning), en de
  // tease blijft heel.
  if (woorden) {
    segmenten.forEach((seg, i) => {
      if (seg.tease) return;
      const ws = woordenIn(woorden, seg.start, seg.end);
      const venster = instelling('RETENTIE_PAYOFF_VENSTER');
      let deelStart = seg.start;
      for (let k = 0; k + 1 < ws.length; k++) {
        const gat = ws[k + 1].s - ws[k].e;
        // Rond de onthulling (begin van het payoff-shot) mag stilte blijven
        // tot het payoff-maximum, en wordt een langere stilte daarheen
        // ingekort in plaats van tot een ademhaling.
        const rondOnthulling = seg.functie === 'payoff' && ws[k].e - seg.start <= venster;
        if (gat <= doelen.maxPauzeS || (rondOnthulling && payoffPauze(seg, ws[k].e - seg.start, gat, doelen.maxPauzeS))) continue;
        const blijft = rondOnthulling ? payoffMax : rest;
        const x = ws[k].e + blijft / 2;
        const y = ws[k + 1].s - blijft / 2;
        if (y - x < 0.05) continue;
        if (x - deelStart < minDeel || seg.end - y < minDeel) {
          ingrepen.push({
            soort: 'overgeslagen',
            volgorde: seg.volgorde,
            bron: rond(ws[k].e),
            wat: `pauze ${nl(gat)} s niet geknipt: een deel zou korter dan ${nl(minDeel)} s worden`,
          });
          continue;
        }
        voegToe(i, { x: rond(x, 3), y: rond(y, 3), soort: 'pauze' });
        ingrepen.push({
          soort: 'pauze',
          volgorde: seg.volgorde,
          bron: rond(ws[k].e),
          wat: `pauze ${nl(gat)} s → ${nl(blijft)} s (na "${ws[k].w}")`,
        });
        deelStart = y;
      }
    });
  }

  // 2. Kaderwissels waar het beeld te lang stilstaat, en de eerste wissel
  // uiterlijk op eersteKnipMaxS. Gepland op de tijdlijn ná de pauzeknippen
  // (die zijn zelf al wissels), op een woordgrens binnen een venster vóór de
  // deadline — liefst het grootste gat daar, want een wissel op een adempauze
  // leest als ritme en een wissel midden in een zinsdeel als onrust.
  if (woorden) {
    const tussen = bouwDelen(segmenten, snedes);
    const { begin, duur } = tijdlijn(tussen.delen);
    const bestaand = wisselMomenten(tussen.delen, kaarten);
    const venster = instelling('RETENTIE_WISSEL_VENSTER');
    type Kandidaat = { t: number; bron: number; deel: number; gat: number };
    const kandidaten: Kandidaat[] = [];
    tussen.delen.forEach((deel, d) => {
      if (deel.tease) return;
      const ws = woordenIn(woorden, deel.start, deel.end);
      for (let k = 0; k + 1 < ws.length; k++) {
        // Overlappende woordtijden (whisper doet dat soms) hebben geen grens
        // om op te knippen.
        if (ws[k + 1].s < ws[k].e - 0.001) continue;
        const bron = (ws[k].e + ws[k + 1].s) / 2;
        if (woordOnder(woorden, bron)) continue;
        if (bron - deel.start < minDeel || deel.end - bron < minDeel) continue;
        kandidaten.push({ t: begin[d] + (bron - deel.start), bron, deel: d, gat: ws[k + 1].s - ws[k].e });
      }
    });

    const nieuw: Kandidaat[] = [];
    let t0 = 0;
    let eerste = true;
    for (let veilig = 0; veilig < 200; veilig++) {
      const limiet = eerste ? doelen.eersteKnipMaxS : doelen.maxSecondenZonderVisueleVerandering;
      const deadline = t0 + limiet;
      // Een staartje van een tiende boven de norm is geen retentieprobleem; een
      // extra wissel vlak voor het einde wel onrust.
      if (deadline >= duur - 0.1) break;
      const volgende = [...bestaand, ...nieuw.map((n) => n.t)].filter((w) => w > t0 + 0.05).sort((a, b) => a - b)[0];
      if (volgende !== undefined && volgende <= deadline) {
        t0 = volgende;
        eerste = false;
        continue;
      }
      const geschikt = kandidaten.filter(
        (c) =>
          c.t >= Math.max(t0 + 0.4, deadline - venster) &&
          c.t <= deadline &&
          nieuw.every((n) => n.deel !== c.deel || Math.abs(n.bron - c.bron) >= minDeel),
      );
      if (geschikt.length === 0) {
        const deelHier = begin.findIndex((b, k) => deadline >= b && deadline < b + (tussen.delen[k].end - tussen.delen[k].start));
        const tease = tussen.delen[deelHier]?.tease;
        ingrepen.push({
          soort: 'overgeslagen',
          volgorde: tussen.delen[deelHier]?.volgorde ?? 0,
          tijdlijn: rond(deadline),
          wat: tease
            ? `${eerste ? 'eerste wissel' : 'kaderwissel'} op ${nl(deadline)} s niet mogelijk: dat is de tease`
            : `${eerste ? 'eerste wissel' : 'kaderwissel'} op ${nl(deadline)} s niet mogelijk: geen woordgrens met genoeg ruimte`,
        });
        t0 = volgende ?? duur;
        eerste = false;
        continue;
      }
      // Het grootste gat wint (tot op 0,1 s), bij gelijkspel het laatste —
      // zo dicht mogelijk bij de deadline, zodat er zo min mogelijk wissels
      // nodig zijn.
      const beste = geschikt.reduce((a, b) => (b.gat > a.gat + 0.1 || (Math.abs(b.gat - a.gat) <= 0.1 && b.t > a.t) ? b : a));
      nieuw.push(beste);
      const i = tussen.oorsprong[beste.deel];
      voegToe(i, { x: rond(beste.bron, 3), y: rond(beste.bron, 3), soort: eerste ? 'eerste_wissel' : 'wissel' });
      ingrepen.push({
        soort: eerste ? 'eerste_wissel' : 'wissel',
        volgorde: segmenten[i].volgorde,
        bron: rond(beste.bron),
        tijdlijn: rond(beste.t),
        wat: `${eerste ? 'eerste wissel' : 'kaderwissel'} op ${nl(beste.t)} s (woordgrens, gat ${nl(beste.gat)} s)`,
      });
      t0 = beste.t;
      eerste = false;
    }
  }

  const { delen } = bouwDelen(segmenten, snedes);

  // 3. Re-hook: één kaart in het zwaarste risicovenster tussen hook en
  // payoff, alleen als die ver genoeg uit elkaar liggen, er een bruikbare
  // regel is, en daar nog geen kaart staat. Eén, niet meer: een tweede
  // re-hook leest als paniek.
  let rehook: Kaart | null = null;
  const regel = (ctx.rehookRegels ?? []).map((r) => r.trim()).find((r) => r.length >= 3 && r.length <= 60);
  if (regel) {
    const tussenMeting = meetRetentie(delen, ctx);
    const { begin } = tijdlijn(delen);
    const p = delen.findIndex((s) => s.functie === 'payoff' && !s.tease);
    const payoffStart = p >= 0 ? begin[p] : null;
    const hookTot = ctx.hookTot ?? 0;
    const duurKaart = instelling('RETENTIE_REHOOK_DUUR');
    if (payoffStart !== null && payoffStart - hookTot >= instelling('RETENTIE_REHOOK_MIN_AANLOOP')) {
      const alleKaarten = [...kaarten, ...segmentKaarten(delen)];
      const stap = tussenMeting.stap;
      let beste: { t: number; risico: number } | null = null;
      for (let t = hookTot + 1; t + duurKaart <= payoffStart - 0.5; t += stap) {
        if (alleKaarten.some((k) => k.start < t + duurKaart + 0.5 && k.end > t - 0.5)) continue;
        const bins = tussenMeting.curve.slice(Math.floor(t / stap), Math.ceil((t + duurKaart) / stap));
        const gem = bins.length ? bins.reduce((a, b) => a + b, 0) / bins.length : 0;
        if (!beste || gem > beste.risico) beste = { t, risico: gem };
      }
      if (beste && beste.risico >= instelling('RETENTIE_REHOOK_MIN_RISICO')) {
        rehook = { start: rond(beste.t), end: rond(beste.t + duurKaart), tekst: regel };
        ingrepen.push({
          soort: 'rehook',
          volgorde: 0,
          tijdlijn: rehook.start,
          wat: `re-hook "${regel}" op ${nl(rehook.start)} s (risico ${nl(beste.risico * 10)}/10, payoff op ${nl(payoffStart)} s)`,
        });
      }
    }
  }

  const na = meetRetentie(delen, { ...ctx, kaarten: rehook ? [...kaarten, rehook] : kaarten });

  const pauzeIngrepen = ingrepen.filter((g) => g.soort === 'pauze');
  const weg = [...snedes.values()].flat().filter((s) => s.soort === 'pauze').reduce((t, s) => t + (s.y - s.x), 0);
  const wissels = ingrepen.filter((g) => g.soort === 'wissel' || g.soort === 'eerste_wissel').length;
  const logregel =
    `retentie: ${pauzeIngrepen.length} pauzes weg (${nl(weg)} s), ${wissels} kaderwissels, ` +
    `eerste wissel ${na.eersteWissel === null ? '—' : `${nl(na.eersteWissel)} s`}, ` +
    `max gat ${nl(voor.maxGatBeeld)} s → ${nl(na.maxGatBeeld)} s` +
    (rehook ? `, re-hook op ${nl(rehook.start)} s` : '') +
    ` (doelen: ${doelen.bron}${doelen.n ? `, n=${doelen.n}` : ''})`;

  return { segmenten: delen, doelen, voor, na, ingrepen, rehook, logregel };
}

// ------------------------------------------------------------------ keuring en samenvatting

/**
 * De keuringsregel "retentie": zijn de resterende gaten binnen de doelen?
 * Gemeten op de definitieve segmenten, dus ná alle correcties van de poort.
 * Zonder woordtijden zijn pauzes en tekst niet te toetsen — dan geen groen.
 */
export function keurRetentie(meting: RetentieMeting, doelen: EditDoelen, opties: { ondertitels?: boolean } = {}): KeuringRegel {
  const naam = 'retentie';
  if (!meting.metWoorden) {
    return { naam, goed: null, detail: 'geen woordtijden; pauzes en tekst in beeld niet te toetsen' };
  }
  const marge = instelling('RETENTIE_KEURING_MARGE');
  const fouten: string[] = [];
  if (meting.eersteWissel === null || meting.eersteWissel > doelen.eersteKnipMaxS * marge) {
    fouten.push(`eerste wissel ${meting.eersteWissel === null ? 'nooit' : `op ${nl(meting.eersteWissel)} s`} (doel ${nl(doelen.eersteKnipMaxS)} s)`);
  }
  if (meting.maxGatBeeld > doelen.maxSecondenZonderVisueleVerandering * marge) {
    fouten.push(`${nl(meting.maxGatBeeld)} s zonder beeldwissel vanaf ${nl(meting.maxGatBeeldOp)} s (doel ${nl(doelen.maxSecondenZonderVisueleVerandering)} s)`);
  }
  if (meting.pauzes > instelling('RETENTIE_KEURING_MAX_PAUZES')) {
    fouten.push(`${meting.pauzes} pauzes boven ${nl(doelen.maxPauzeS)} s blijven staan (${nl(meting.pauzeSeconden)} s)`);
  }
  if (opties.ondertitels !== false && meting.maxGatTekst !== null && meting.maxGatTekst > doelen.maxSecondenZonderTekst * marge) {
    fouten.push(`${nl(meting.maxGatTekst)} s zonder tekst in beeld (doel ${nl(doelen.maxSecondenZonderTekst)} s)`);
  }
  const telling =
    `eerste wissel ${meting.eersteWissel === null ? '—' : `${nl(meting.eersteWissel)} s`}, ` +
    `max beeldgat ${nl(meting.maxGatBeeld)} s, ${nl(meting.wisselsPer10s)} wissels/10 s, gem. risico ${nl(meting.gemiddeldRisico * 10)}/10`;
  return {
    naam,
    goed: fouten.length === 0,
    detail: fouten.length === 0 ? `${telling}; binnen de doelen (${doelen.bron})` : `${telling}; ${fouten.join('; ')}`,
  };
}

/**
 * Compacte samenvatting voor de edit-agent: wáár het risico zit, per shot, in
 * één regel. Geen curve van honderd getallen — de agent moet kunnen kiezen
 * waar een ingreep het verschil maakt, niet een grafiek lezen.
 */
export function samenvatVoorEditAgent(meting: RetentieMeting): string {
  const delen = [
    `${nl(meting.duur)} s`,
    meting.pauzes ? `${meting.pauzes} pauzes (${nl(meting.pauzeSeconden)} s; de render knipt die zelf)` : 'geen lange pauzes',
    `langste beeldgat ${nl(meting.maxGatBeeld)} s vanaf ${nl(meting.maxGatBeeldOp)} s`,
  ];
  if (meting.knelpunten.length) {
    delen.push(
      `risicopieken: ${meting.knelpunten.map((k) => `${nl(k.t)} s shot ${Math.floor(k.volgorde)} (${k.waarom}, ${nl(k.risico * 10)}/10)`).join('; ')}`,
    );
  }
  return delen.join(' | ');
}
