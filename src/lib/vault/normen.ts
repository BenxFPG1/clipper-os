/**
 * Edit-normen: wat top-clips meetbaar anders doen dan gewone clips.
 *
 * CONTRACT (andere modules bouwen hierop):
 * - editDoelen() levert harde getallen voor de retentie-editor en de keuring.
 * - editNormenVoorPrompt() levert dezelfde kennis als leesbare tekst voor de
 *   edit-agent en de planner.
 *
 * Tot er genoeg gemeten is, vallen beide terug op STANDAARD_DOELEN: een
 * behoudende basis die al beter is dan niets, en die expliciet als
 * 'standaard' gemarkeerd staat zodat niemand denkt dat het geleerd is.
 *
 * Waar de getallen vandaan komen (zie aggregeerNormen):
 * - extern: vingerafdrukken van uitschieters (top) tegen gewone posts van
 *   dezelfde accounts (basislijn). Zonder die basislijn leer je alleen wat
 *   iedereen doet, niet wat de uitschieter ánders doet.
 * - eigen: onze renders die als 'goed' beoordeeld zijn of goed liepen,
 *   tegen die als 'weg' beoordeeld zijn of slecht liepen.
 * Alleen kenmerken met een duidelijk verschil (rangtest) én genoeg metingen
 * per groep worden een norm; de rest staat als "verschilt niet" in de prompt,
 * want ook dát is kennis (dan hoeft de montage er niet op te sturen).
 */
import { db } from '../supabase';
// Alleen het type: normen.ts wordt ook vanuit de webapp (status.ts) geladen en
// mag daarom geen ffmpeg/claude-code-runtime meetrekken.
import type { Vingerafdruk } from '../analyse/vingerafdruk';

/** Zelfde grens als MAX_SHORTFORM_S in vingerafdruk.ts (bewust gedupliceerd, zie import hierboven). */
const MAX_SHORTFORM_S = Number(process.env.VINGERAFDRUK_MAX_DUUR_S ?? 180);

export type EditDoelen = {
  /** Uiterlijk op deze seconde de eerste visuele verandering (knip, zoom, kaart). */
  eersteKnipMaxS: number;
  /** Streefaantal visuele veranderingen per 10 seconden. */
  knippenPer10s: number;
  /** Langer dan dit zonder visuele verandering is een retentierisico. */
  maxSecondenZonderVisueleVerandering: number;
  /** Langer dan dit zonder tekst in beeld (ondertitel telt mee) is een risico. */
  maxSecondenZonderTekst: number;
  /** Pauzes in spraak langer dan dit worden weggeknipt. */
  maxPauzeS: number;
  /** Aandeel van de clip met tekst in beeld (0..1). */
  tekstInBeeldAandeel: number;
  /** Waar de getallen vandaan komen. */
  bron: 'extern' | 'eigen' | 'mix' | 'standaard';
  /** Aantal gemeten clips achter deze doelen. */
  n: number;
  /** Minimaal aantal visuele veranderingen in de eerste 3 seconden. */
  wisselsEerste3sMin: number;
  /** Uiterlijk op deze seconde begint de spraak. */
  spraakStartMaxS: number;
};

/**
 * Herkomst per doel en voor welke groep de doelen gelden. Bewust niet ín
 * EditDoelen: afnemers lopen over de getalvelden van EditDoelen heen (alles
 * behalve bron/n is een getal), en dat contract blijft zo heel.
 */
export type DoelHerkomst = {
  bronPerDoel: Partial<Record<DoelSleutel, 'extern' | 'eigen' | 'mix' | 'standaard'>>;
  geldigVoor: { platform: string; theme: string } | null;
};

export const STANDAARD_DOELEN: EditDoelen = {
  eersteKnipMaxS: 2.0,
  knippenPer10s: 3.0,
  maxSecondenZonderVisueleVerandering: 4.0,
  maxSecondenZonderTekst: 1.5,
  maxPauzeS: 0.45,
  tekstInBeeldAandeel: 0.9,
  bron: 'standaard',
  n: 0,
  wisselsEerste3sMin: 1,
  spraakStartMaxS: 0.5,
};

export type NormContext = { platform?: string | null; theme?: string | null };

/* ----------------------------------------------------------- kenmerken */

/**
 * De kenmerken die we vergelijken. Elk leest één getal uit een vingerafdruk;
 * null = niet gemeten (bv. geen visuele pas), en telt dan niet mee in n.
 */
export const KENMERKEN = {
  eersteWisselS: { label: 'eerste visuele wissel', eenheid: 's', lees: (v: Vingerafdruk) => v.eersteWisselS },
  wisselsPer10s: { label: 'wissels per 10 s', eenheid: '', lees: (v: Vingerafdruk) => v.wisselsPer10s },
  wisselsEerste3s: { label: 'wissels in de eerste 3 s', eenheid: '', lees: (v: Vingerafdruk) => v.wisselsEerste3s },
  mediaanShotS: { label: 'mediane shotlengte', eenheid: 's', lees: (v: Vingerafdruk) => v.mediaanShotS },
  langsteZonderWisselS: { label: 'langste stuk zonder wissel', eenheid: 's', lees: (v: Vingerafdruk) => v.langsteZonderWisselS },
  spraakStartS: { label: 'spraakstart', eenheid: 's', lees: (v: Vingerafdruk) => v.spraakStartS },
  pauzesPerMin: { label: 'pauzes >0,4 s per minuut', eenheid: '', lees: (v: Vingerafdruk) => v.pauzesPerMin },
  woordenPerS: { label: 'spreektempo (woorden/s)', eenheid: '', lees: (v: Vingerafdruk) => v.woordenPerS },
  loudnessI: { label: 'loudness', eenheid: ' LUFS', lees: (v: Vingerafdruk) => v.loudnessI },
  loudnessLRA: { label: 'loudness range', eenheid: ' LU', lees: (v: Vingerafdruk) => v.loudnessLRA },
  duurS: { label: 'duur', eenheid: 's', lees: (v: Vingerafdruk) => v.duurS },
  tekstInBeeldAandeel: { label: 'tekst in beeld', eenheid: '%', lees: (v: Vingerafdruk) => v.visueel?.tekstInBeeldAandeel ?? null },
  langsteZonderTekstS: { label: 'langste stuk zonder tekst', eenheid: 's', lees: (v: Vingerafdruk) => v.visueel?.langsteZonderTekstS ?? null },
  tekstInEersteFrame: {
    label: 'tekst in het eerste frame',
    eenheid: '%',
    lees: (v: Vingerafdruk) => (v.visueel ? (v.visueel.tekstInEersteFrame ? 1 : 0) : null),
  },
  woordVoorWoord: {
    label: 'woord-voor-woord-ondertitels',
    eenheid: '%',
    lees: (v: Vingerafdruk) => (v.visueel ? (v.visueel.ondertitelstijl === 'woord-voor-woord' ? 1 : 0) : null),
  },
  zoomZichtbaar: {
    label: 'zichtbare zoom/beweging',
    eenheid: '%',
    lees: (v: Vingerafdruk) => (v.visueel ? (v.visueel.beweging_zoom_zichtbaar ? 1 : 0) : null),
  },
  broll: { label: 'b-roll', eenheid: '%', lees: (v: Vingerafdruk) => (v.visueel ? (v.visueel.broll ? 1 : 0) : null) },
} as const;

export type Kenmerk = keyof typeof KENMERKEN;
export type DoelSleutel = 'eersteKnipMaxS' | 'knippenPer10s' | 'maxSecondenZonderVisueleVerandering' | 'maxSecondenZonderTekst' | 'tekstInBeeldAandeel' | 'wisselsEerste3sMin' | 'spraakStartMaxS';

/** Minimaal aantal metingen per groep voordat een verschil iets zegt. */
export const MIN_N = 8;
/**
 * Cliff's delta vanaf deze grootte telt als "duidelijk verschil" (0,33 is
 * de gangbare grens voor een middelgroot effect). Een rangmaat en geen
 * gemiddelde: één clip met 40 wissels trekt een gemiddelde scheef, een rang
 * niet — precies wat je wilt bij scrapedata vol uitschieters.
 */
export const MIN_EFFECT = 0.33;

export type Groep = 'top' | 'basis' | 'eigen_goed' | 'eigen_weg';
/**
 * account: wie de clip maakte (handle uit de URL). Nodig voor de gepaarde
 * analyse: top en basislijn van hetzelfde account vergelijken.
 */
export type Meting = { groep: Groep; platform: string | null; theme: string | null; v: Vingerafdruk; account?: string | null };

/** Gepaarde vergelijking binnen accounts (zie gepaardeToets). */
export type GepaardResultaat = {
  /** Accounts met zowel een top- als een basislijnmeting. */
  n_accounts: number;
  /** Mediaan over accounts van (mediaan top − mediaan basis) binnen het account. */
  mediaan_verschil: number;
  /** Mediaan over de gepaarde accounts van hun top- resp. basismediaan. */
  top: number;
  basis: number;
  /** Bij hoeveel accounts top hoger/lager dan basis ligt (gelijk telt niet). */
  hoger: number;
  lager: number;
  /** Tweezijdige p-waarde, Wilcoxon signed-rank (exact, conditioneel op de rangen). */
  p: number;
  /** Rank-biserial correlatie (-1..1): de gepaarde effectgrootte. */
  r: number;
};

export type KenmerkNorm = {
  top: number | null;
  basis: number | null;
  eigen_goed: number | null;
  eigen_weg: number | null;
  /** Cliff's delta top vs basis (-1..1); positief = top hoger. */
  effect: number | null;
  /** Cliff's delta eigen goed vs weg. */
  effect_eigen: number | null;
  n: Record<Groep, number>;
  /** Duidelijk verschil extern (top vs basis) met genoeg metingen. */
  norm_extern: boolean;
  /** Duidelijk verschil eigen (goed vs weg) met genoeg metingen. */
  norm_eigen: boolean;
  /**
   * Welke toets over norm_extern besliste: 'gepaard' zodra er genoeg accounts
   * met beide soorten zijn, anders de ongepaarde vergelijking als terugval.
   * Optioneel: rijen van vóór de gepaarde analyse hebben het veld niet.
   */
  methode?: 'gepaard' | 'ongepaard';
  gepaard?: GepaardResultaat | null;
};

export type Normen = Partial<Record<Kenmerk, KenmerkNorm>>;

/* --------------------------------------------------------------- statistiek */

export function mediaan(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Cliff's delta: P(a > b) − P(a < b) over alle paren. -1..1, 0 = geen
 * verschil. Rangbaseerd, dus ongevoelig voor één absurde meting.
 */
export function cliffsDelta(a: number[], b: number[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  let groter = 0;
  let kleiner = 0;
  for (const x of a) for (const y of b) {
    if (x > y) groter++;
    else if (x < y) kleiner++;
  }
  return (groter - kleiner) / (a.length * b.length);
}

/**
 * Wilcoxon signed-rank op gepaarde verschillen, puur TypeScript.
 *
 * Waarom gepaard: ongepaard (alle tops tegen alle basisposts) verdrinkt het
 * verschil binnen een account in de verschillen tússen accounts — een
 * voetbalcompilatie knipt altijd sneller dan een talking head, of het nu een
 * uitschieter is of niet. Met 75/73 metingen haalde geen enkel kenmerk nog een
 * duidelijk ongepaard effect. Per account "top min gewoon" nemen haalt die
 * stijl eruit; de vraag wordt dan: wijzen die verschillen over accounts heen
 * systematisch één kant op?
 *
 * Exact in plaats van de normale benadering: bij 8–30 accounts is die
 * benadering te grof. De verdeling wordt per keer opgebouwd over de werkelijke
 * (mid)rangen, dus ties zijn geen probleem. Nullen tellen niet mee (standaard).
 */
export function wilcoxonSignedRank(verschillen: number[]): { n: number; wPlus: number; wMin: number; p: number; r: number } | null {
  const d = verschillen.filter((x) => Number.isFinite(x) && Math.abs(x) > 1e-9);
  const n = d.length;
  if (n === 0) return null;
  // Midrangen van |d|, verdubbeld zodat ze gehele getallen zijn.
  const orde = d.map((x, i) => ({ a: Math.abs(x), i })).sort((x, y) => x.a - y.a);
  const rang2 = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && Math.abs(orde[j + 1].a - orde[i].a) < 1e-9) j++;
    const mid2 = i + j + 2; // (i+1 + j+1) = 2 × midrang
    for (let k = i; k <= j; k++) rang2[orde[k].i] = mid2;
    i = j + 1;
  }
  const totaal2 = rang2.reduce((a, b) => a + b, 0);
  const wPlus2 = d.reduce((a, x, i) => a + (x > 0 ? rang2[i] : 0), 0);
  // Verdeling van W+ onder H0: elk teken 50/50. Telling in doubles is exact
  // genoeg (2^30 past ruim).
  let verdeling = new Array<number>(totaal2 + 1).fill(0);
  verdeling[0] = 1;
  for (const r of rang2) {
    const nieuw = verdeling.slice();
    for (let s = totaal2 - r; s >= 0; s--) if (verdeling[s]) nieuw[s + r] += verdeling[s];
    verdeling = nieuw;
  }
  const alles = 2 ** n;
  let links = 0;
  let rechts = 0;
  for (let s = 0; s <= totaal2; s++) {
    if (s <= wPlus2) links += verdeling[s];
    if (s >= wPlus2) rechts += verdeling[s];
  }
  const p = Math.min(1, (2 * Math.min(links, rechts)) / alles);
  const wPlus = wPlus2 / 2;
  const wMin = (totaal2 - wPlus2) / 2;
  return { n, wPlus, wMin, p, r: (wPlus - wMin) / (wPlus + wMin) };
}

/** Onder deze p-waarde telt een gepaard verschil als systematisch. */
export const MAX_P = 0.05;
/**
 * De ongepaarde terugval telt alleen als beide groepen uit minstens zoveel
 * verschillende accounts komen. Anders meet je accounts, niet uitschieters:
 * de eerste echte run gaf in comedy (17 tops, 9 basisposts uit een handvol
 * accounts) vier "normen", waarvan twee met gelijke medianen.
 */
export const MIN_ACCOUNTS_ONGEPAARD = 5;

/**
 * Puur: gepaarde toets voor één kenmerk. Per account de mediaan van top en
 * van basis; alleen accounts met beide tellen. Null als er geen paar is.
 */
export function gepaardeToets(waarden: { account: string; groep: 'top' | 'basis'; w: number }[]): GepaardResultaat | null {
  const perAccount = new Map<string, { top: number[]; basis: number[] }>();
  for (const x of waarden) {
    const a = perAccount.get(x.account) ?? { top: [], basis: [] };
    a[x.groep].push(x.w);
    perAccount.set(x.account, a);
  }
  const paren = [...perAccount.values()]
    .filter((a) => a.top.length > 0 && a.basis.length > 0)
    .map((a) => ({ top: mediaan(a.top)!, basis: mediaan(a.basis)! }));
  if (paren.length === 0) return null;
  const verschillen = paren.map((x) => x.top - x.basis);
  const w = wilcoxonSignedRank(verschillen);
  return {
    n_accounts: paren.length,
    mediaan_verschil: rond(mediaan(verschillen))!,
    top: rond(mediaan(paren.map((x) => x.top)))!,
    basis: rond(mediaan(paren.map((x) => x.basis)))!,
    hoger: verschillen.filter((x) => x > 1e-9).length,
    lager: verschillen.filter((x) => x < -1e-9).length,
    p: w ? Math.round(w.p * 1000) / 1000 : 1,
    r: w ? Math.round(w.r * 100) / 100 : 0,
  };
}

/** Puur: van metingen naar normen per kenmerk. */
export function aggregeerNormen(metingen: Meting[], opties: { minN?: number; minEffect?: number; maxP?: number } = {}): Normen {
  const minN = opties.minN ?? MIN_N;
  const minEffect = opties.minEffect ?? MIN_EFFECT;
  const maxP = opties.maxP ?? MAX_P;
  const normen: Normen = {};
  for (const [sleutel, def] of Object.entries(KENMERKEN) as [Kenmerk, (typeof KENMERKEN)[Kenmerk]][]) {
    const waarden: Record<Groep, number[]> = { top: [], basis: [], eigen_goed: [], eigen_weg: [] };
    const metAccount: { account: string; groep: 'top' | 'basis'; w: number }[] = [];
    for (const m of metingen) {
      let w: number | null = null;
      try {
        w = def.lees(m.v);
      } catch {
        // Een onvolledige vingerafdruk (oude versie, half gevuld) telt niet mee.
      }
      if (typeof w === 'number' && Number.isFinite(w)) {
        waarden[m.groep].push(w);
        if (m.account && (m.groep === 'top' || m.groep === 'basis')) metAccount.push({ account: m.account, groep: m.groep, w });
      }
    }
    const n = { top: waarden.top.length, basis: waarden.basis.length, eigen_goed: waarden.eigen_goed.length, eigen_weg: waarden.eigen_weg.length };
    if (n.top + n.basis + n.eigen_goed + n.eigen_weg === 0) continue;
    const effect = cliffsDelta(waarden.top, waarden.basis);
    const effectEigen = cliffsDelta(waarden.eigen_goed, waarden.eigen_weg);
    const accounts = (g: 'top' | 'basis') => new Set(metAccount.filter((x) => x.groep === g).map((x) => x.account)).size;
    // Metingen zonder account (oude rijen, tests) kunnen de spreiding niet
    // aantonen maar ook niet ontkrachten; dan geldt alleen de n-eis.
    const genoegAccounts = (g: 'top' | 'basis') => metAccount.length === 0 || accounts(g) >= MIN_ACCOUNTS_ONGEPAARD;
    const medTop = mediaan(waarden.top);
    const medBasis = mediaan(waarden.basis);
    // Gelijke medianen = het verschil zit alleen in de staarten; daar kan de
    // montage niet op sturen ("top 100% vs gewoon 100%" is geen norm).
    const ongepaardNorm =
      effect !== null && n.top >= minN && n.basis >= minN && Math.abs(effect) >= minEffect &&
      medTop !== medBasis && genoegAccounts('top') && genoegAccounts('basis');
    // Gepaard gaat voor zodra er genoeg accounts met beide soorten zijn: dat
    // is de eerlijkere vergelijking. Anders de ongepaarde als terugval.
    const gepaard = gepaardeToets(metAccount);
    const gepaardBruikbaar = gepaard !== null && gepaard.n_accounts >= minN;
    const gepaardNorm = gepaardBruikbaar && gepaard!.p < maxP && Math.abs(gepaard!.r) >= minEffect && gepaard!.mediaan_verschil !== 0;
    normen[sleutel] = {
      top: rond(mediaan(waarden.top)),
      basis: rond(mediaan(waarden.basis)),
      eigen_goed: rond(mediaan(waarden.eigen_goed)),
      eigen_weg: rond(mediaan(waarden.eigen_weg)),
      effect: effect === null ? null : Math.round(effect * 100) / 100,
      effect_eigen: effectEigen === null ? null : Math.round(effectEigen * 100) / 100,
      n,
      norm_extern: gepaardBruikbaar ? gepaardNorm : ongepaardNorm,
      methode: gepaardBruikbaar ? 'gepaard' : 'ongepaard',
      gepaard,
      norm_eigen: effectEigen !== null && n.eigen_goed >= minN && n.eigen_weg >= minN && Math.abs(effectEigen) >= minEffect,
    };
  }
  return normen;
}

/**
 * Welk kenmerk stuurt welk doel, met grenzen en afronding. De grenzen zijn
 * behoudend: ook als de data iets extreems zegt, blijft een doel iets wat
 * onze montage redelijkerwijs kan halen en wat geen onkijkbare clip afdwingt
 * (20 knippen per 10 s "omdat de top dat doet" is een meetfout of een
 * compilatie, geen norm voor ons materiaal). Afronden richting STANDAARD
 * (naar boven voor een maximum, naar beneden voor een streefaantal) zodat een
 * geleerde norm nooit strenger is dan de data rechtvaardigt.
 */
const DOEL_REGELS: {
  doel: DoelSleutel;
  kenmerk: Kenmerk;
  min: number;
  max: number;
  stap: number;
  afronden: 'op' | 'neer';
}[] = [
  { doel: 'eersteKnipMaxS', kenmerk: 'eersteWisselS', min: 0.5, max: 3, stap: 0.1, afronden: 'op' },
  { doel: 'knippenPer10s', kenmerk: 'wisselsPer10s', min: 1, max: 8, stap: 0.5, afronden: 'neer' },
  { doel: 'maxSecondenZonderVisueleVerandering', kenmerk: 'langsteZonderWisselS', min: 2, max: 8, stap: 0.5, afronden: 'op' },
  { doel: 'maxSecondenZonderTekst', kenmerk: 'langsteZonderTekstS', min: 0.5, max: 4, stap: 0.5, afronden: 'op' },
  { doel: 'tekstInBeeldAandeel', kenmerk: 'tekstInBeeldAandeel', min: 0.5, max: 0.98, stap: 0.05, afronden: 'neer' },
  { doel: 'wisselsEerste3sMin', kenmerk: 'wisselsEerste3s', min: 0, max: 4, stap: 1, afronden: 'neer' },
  { doel: 'spraakStartMaxS', kenmerk: 'spraakStartS', min: 0.2, max: 2, stap: 0.1, afronden: 'op' },
];

export function begrens(waarde: number, min: number, max: number, stap: number, afronden: 'op' | 'neer'): number {
  const r = afronden === 'op' ? Math.ceil(waarde / stap - 1e-9) * stap : Math.floor(waarde / stap + 1e-9) * stap;
  const g = Math.min(max, Math.max(min, r));
  return Math.round(g * 1000) / 1000;
}

/** Puur: van normen naar doelen. Zonder norm blijft het STANDAARD-doel staan. */
export function doelenUitNormen(normen: Normen, nTotaal: number): EditDoelen & Pick<DoelHerkomst, 'bronPerDoel'> {
  const doelen: EditDoelen & Pick<DoelHerkomst, 'bronPerDoel'> = { ...STANDAARD_DOELEN, bronPerDoel: {} };
  const bronnen = new Set<'extern' | 'eigen'>();
  for (const r of DOEL_REGELS) {
    const k = normen[r.kenmerk];
    if (!k) continue;
    // Gepaard: de mediaan van de top-mediaan per account — elk account telt
    // één keer, zodat een account met twintig vondsten de norm niet bepaalt.
    const topWaarde = k.methode === 'gepaard' && k.gepaard ? k.gepaard.top : k.top;
    const extern = k.norm_extern && topWaarde !== null ? topWaarde : null;
    const eigen = k.norm_eigen && k.eigen_goed !== null ? k.eigen_goed : null;
    if (extern === null && eigen === null) {
      doelen.bronPerDoel[r.doel] = 'standaard';
      continue;
    }
    // Beide bronnen: het midden. Extern is breder gemeten, eigen is ons
    // eigen publiek en materiaal — geen van beide wint vanzelf.
    const ruw = extern !== null && eigen !== null ? (extern + eigen) / 2 : (extern ?? eigen)!;
    let doel = begrens(ruw, r.min, r.max, r.stap, r.afronden);
    // Een geleerd doel mag nooit tegen de richting van de data in bewegen.
    // Knippen de beste clips strakker dan gewone posts (top < basis), dan is
    // het doel hoogstens de standaard, ook als de top-mediaan zelf ruimer is
    // dan de standaard: comedy-tops hadden 6,3 s zonder wissel tegen 8,8 s bij
    // gewone posts, en 'doel = top' maakte daar 6,5 s van — ruimer dan de 4 s
    // standaard, dus het tegendeel van wat de meting zegt.
    const effect =
      extern !== null
        ? k.methode === 'gepaard' && k.gepaard
          ? k.gepaard.mediaan_verschil
          : k.effect
        : k.effect_eigen;
    const standaard = STANDAARD_DOELEN[r.doel];
    if (typeof effect === 'number' && effect < 0) doel = Math.min(doel, standaard);
    if (typeof effect === 'number' && effect > 0) doel = Math.max(doel, standaard);
    doelen[r.doel] = doel;
    const bron = extern !== null && eigen !== null ? 'mix' : extern !== null ? 'extern' : 'eigen';
    doelen.bronPerDoel[r.doel] = bron;
    if (extern !== null) bronnen.add('extern');
    if (eigen !== null) bronnen.add('eigen');
  }
  doelen.bron = bronnen.size === 0 ? 'standaard' : bronnen.size === 2 ? 'mix' : [...bronnen][0];
  doelen.n = doelen.bron === 'standaard' ? 0 : nTotaal;
  return doelen;
}

/* ----------------------------------------------------------------- tekst */

function fmt(k: Kenmerk, w: number | null): string {
  if (w === null) return '—';
  const def = KENMERKEN[k];
  if (def.eenheid === '%') return `${Math.round(w * 100)}%`;
  const s = (Math.round(w * 10) / 10).toString().replace('.', ',');
  return `${s}${def.eenheid === 's' ? ' s' : def.eenheid}`;
}

/** Puur: korte, concrete prompttekst. Leeg als er geen enkele norm is. */
export function normenTekst(normen: Normen, platform: string, theme: string): string {
  const alle = Object.entries(normen) as [Kenmerk, KenmerkNorm][];
  const extern = alle.filter(([, k]) => k.norm_extern).sort((a, b) => Math.abs(b[1].effect ?? 0) - Math.abs(a[1].effect ?? 0));
  const eigen = alle.filter(([, k]) => k.norm_eigen).sort((a, b) => Math.abs(b[1].effect_eigen ?? 0) - Math.abs(a[1].effect_eigen ?? 0));
  if (extern.length === 0 && eigen.length === 0) return '';

  const waar = platform === 'all' && theme === 'all' ? 'alle platforms/thema\'s' : `${theme === 'all' ? 'alle thema\'s' : theme}/${platform === 'all' ? 'alle platforms' : platform}`;
  const nAccounts = Math.max(0, ...alle.map(([, k]) => (k.methode === 'gepaard' ? (k.gepaard?.n_accounts ?? 0) : 0)));
  const methodeUitleg =
    nAccounts > 0
      ? `gepaard: uitschieter vs gewone post van hetzelfde account, ${nAccounts} accounts, Wilcoxon p<${MAX_P}`
      : 'ongepaard: alle uitschieters vs alle gewone posts, rangtest';
  const regels: string[] = [`GEMETEN EDIT-NORMEN (${waar}; ${methodeUitleg} — gemeten met ffmpeg + frame-analyse, geen mening):`];
  for (const [k, n] of extern.slice(0, 9)) {
    const g = n.gepaard;
    if (n.methode === 'gepaard' && g) {
      const teken = g.mediaan_verschil > 0 ? '+' : '';
      regels.push(
        `- ${KENMERKEN[k].label}: top ${fmt(k, g.top)} vs gewone posts ${fmt(k, g.basis)} binnen hetzelfde account (verschil ${teken}${fmt(k, g.mediaan_verschil)}; ${g.mediaan_verschil > 0 ? 'hoger' : 'lager'} bij ${g.mediaan_verschil > 0 ? g.hoger : g.lager} van ${g.n_accounts} accounts, p=${String(g.p).replace('.', ',')})`,
      );
    } else {
      regels.push(`- ${KENMERKEN[k].label}: top ${fmt(k, n.top)} vs gewone posts ${fmt(k, n.basis)} (ongepaard, n=${n.n.top}/${n.n.basis})`);
    }
  }
  for (const [k, n] of eigen.slice(0, 6)) {
    regels.push(`- eigen renders, ${KENMERKEN[k].label}: 'goed' ${fmt(k, n.eigen_goed)} vs 'weg' ${fmt(k, n.eigen_weg)} (n=${n.n.eigen_goed}/${n.n.eigen_weg})`);
  }
  // Wat NIET verschilt: gemeten met genoeg n, maar geen duidelijk effect. Dat
  // voorkomt dat de edit-agent energie steekt in iets wat niets uitmaakt.
  const gelijk = alle
    .filter(([, k]) => !k.norm_extern && (k.methode === 'gepaard' || (k.n.top >= MIN_N && k.n.basis >= MIN_N)))
    .map(([k, n]) => `${KENMERKEN[k].label} (~${fmt(k, n.methode === 'gepaard' && n.gepaard ? n.gepaard.top : n.top)})`);
  if (gelijk.length > 0) regels.push(`- Verschilt NIET tussen top en gewoon: ${gelijk.slice(0, 8).join('; ')}.`);
  regels.push('Stuur op de verschillen; wat niet verschilt is vrij.');
  return regels.slice(0, 25).join('\n');
}

/* ------------------------------------------------------------ database */

type NormRij = { platform: string; theme: string; normen: Normen; doelen: EditDoelen & Partial<DoelHerkomst>; n_top: number; n_basis: number; n_eigen: number; created_at: string };

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { t: number; rij: NormRij | null }>();

/** Voor tests en na een nieuwe aggregatie. */
export function wisNormCache() {
  cache.clear();
}

async function laadRij(platform: string, theme: string): Promise<NormRij | null> {
  const sleutel = `${platform}|${theme}`;
  const hit = cache.get(sleutel);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.rij;
  let rij: NormRij | null = null;
  try {
    const { data, error } = await db()
      .from('edit_normen')
      .select('platform, theme, normen, doelen, n_top, n_basis, n_eigen, created_at')
      .eq('platform', platform)
      .eq('theme', theme)
      .order('created_at', { ascending: false })
      .limit(1);
    if (!error) rij = (data?.[0] as NormRij | undefined) ?? null;
  } catch {
    // Geen database (lokaal zonder env, tabel nog niet gemigreerd): de
    // montage mag daar nooit op stuklopen — dan gelden de standaarddoelen.
  }
  cache.set(sleutel, { t: Date.now(), rij });
  return rij;
}

/**
 * Specifiek naar algemeen: platform+thema, platform, thema, alles. Een rij
 * die wel bestaat maar nog niets geleerd heeft ('standaard') slaan we over,
 * anders verstopt een dun gemeten thema de normen van het geheel.
 */
async function besteRij(ctx: NormContext): Promise<NormRij | null> {
  const p = ctx.platform?.trim() || 'all';
  const t = ctx.theme?.trim() || 'all';
  const volgorde: [string, string][] = [[p, t], [p, 'all'], ['all', t], ['all', 'all']];
  const gezien = new Set<string>();
  for (const [pl, th] of volgorde) {
    const k = `${pl}|${th}`;
    if (gezien.has(k)) continue;
    gezien.add(k);
    const rij = await laadRij(pl, th);
    if (rij && rij.doelen?.bron && rij.doelen.bron !== 'standaard') return rij;
  }
  return null;
}

/** Harde doelen voor dit platform/thema; valt terug op 'all' en daarna op STANDAARD_DOELEN. */
export async function editDoelen(ctx: NormContext = {}): Promise<EditDoelen> {
  const rij = await besteRij(ctx);
  if (!rij) return STANDAARD_DOELEN;
  return schoneDoelen(rij.doelen);
}

/**
 * Alleen de bekende EditDoelen-velden, elk een eindig getal; wat ontbreekt of
 * kapot is (oudere rij, handmatige edit) krijgt de standaardwaarde.
 */
export function schoneDoelen(ruw: Partial<Record<string, unknown>> | null | undefined): EditDoelen {
  const uit: EditDoelen = { ...STANDAARD_DOELEN };
  for (const k of Object.keys(STANDAARD_DOELEN) as (keyof EditDoelen)[]) {
    const w = ruw?.[k];
    if (k === 'bron') {
      if (w === 'extern' || w === 'eigen' || w === 'mix' || w === 'standaard') uit.bron = w;
    } else if (typeof w === 'number' && Number.isFinite(w)) {
      (uit as Record<string, unknown>)[k] = w;
    }
  }
  return uit;
}

/** Zelfde als editDoelen, plus waar elk doel vandaan komt (voor UI en logs). */
export async function editDoelenMetHerkomst(ctx: NormContext = {}): Promise<{ doelen: EditDoelen } & DoelHerkomst> {
  const rij = await besteRij(ctx);
  if (!rij) return { doelen: STANDAARD_DOELEN, bronPerDoel: {}, geldigVoor: null };
  return { doelen: schoneDoelen(rij.doelen), bronPerDoel: rij.doelen.bronPerDoel ?? {}, geldigVoor: { platform: rij.platform, theme: rij.theme } };
}

/** Leesbare normen voor in een prompt; lege string als er nog niets gemeten is. */
export async function editNormenVoorPrompt(ctx: NormContext = {}): Promise<string> {
  const rij = await besteRij(ctx);
  if (!rij) return '';
  return normenTekst(rij.normen ?? {}, rij.platform, rij.theme);
}

/* ------------------------------------------------------------ aggregatie */

function isVingerafdruk(x: unknown): x is Vingerafdruk {
  return Boolean(x && typeof x === 'object' && typeof (x as Vingerafdruk).duurS === 'number' && typeof (x as Vingerafdruk).versie === 'number');
}

/** Een eigen geposte clip telt als 'goed' of 'weg' op basis van zijn eigen outlier-score (t.o.v. onze mediaan). */
const EIGEN_GOED_SCORE = 1.5;
const EIGEN_WEG_SCORE = 0.7;

/**
 * Haalt alle metingen op: externe vondsten (top/basis) en eigen renders
 * (beoordeling of prestaties). Leest de eigen kant defensief: die tabellen en
 * velden worden door de feedbacklus gevuld en kunnen leeg of half zijn.
 */
export async function laadMetingen(): Promise<{ metingen: Meting[]; waarschuwingen: string[] }> {
  const supabase = db();
  const metingen: Meting[] = [];
  const waarschuwingen: string[] = [];

  // Extern, in pagina's: de tabel groeit, en supabase geeft standaard max 1000.
  for (let van = 0; ; van += 1000) {
    const { data, error } = await supabase
      .from('scout_finds')
      .select('platform, theme, is_basislijn, vingerafdruk, post_url, tracked_account_id')
      .not('vingerafdruk', 'is', null)
      .range(van, van + 999);
    if (error) throw new Error(`scout_finds lezen: ${error.message}`);
    for (const r of data ?? []) {
      if (!isVingerafdruk(r.vingerafdruk)) continue;
      // Metingen van vóór de duurgrens (lange video's) tellen niet mee.
      if (r.vingerafdruk.duurS > MAX_SHORTFORM_S) continue;
      metingen.push({
        groep: r.is_basislijn ? 'basis' : 'top',
        platform: r.platform as string,
        theme: r.theme as string | null,
        v: r.vingerafdruk,
        account: accountSleutel(r.post_url as string | null, r.tracked_account_id as string | null),
      });
    }
    if (!data || data.length < 1000) break;
  }

  // Eigen renders: vingerafdruk per bestand in render_jobs.bestanden.
  const vingerVan = new Map<string, Vingerafdruk>();
  const gelezen = new Set<string>();
  const leesRenders = async (ids: string[]) => {
    const nodig = [...new Set(ids)].filter((id) => id && !gelezen.has(id));
    nodig.forEach((id) => gelezen.add(id));
    for (let i = 0; i < nodig.length; i += 100) {
      const { data } = await supabase.from('render_jobs').select('id, bestanden').in('id', nodig.slice(i, i + 100));
      for (const job of data ?? []) {
        const bestanden = Array.isArray(job.bestanden) ? (job.bestanden as { naam?: string; vingerafdruk?: unknown }[]) : [];
        for (const b of bestanden) if (b?.naam && isVingerafdruk(b.vingerafdruk)) vingerVan.set(`${job.id}|${b.naam}`, b.vingerafdruk);
      }
    }
  };

  try {
    const { data: oordelen, error } = await supabase
      .from('render_beoordelingen')
      .select('render_job_id, bestand_naam, oordeel')
      .in('oordeel', ['goed', 'weg']);
    if (error) throw error;
    await leesRenders((oordelen ?? []).map((o) => o.render_job_id as string));
    for (const o of oordelen ?? []) {
      const v = vingerVan.get(`${o.render_job_id}|${o.bestand_naam}`);
      if (v) metingen.push({ groep: o.oordeel === 'goed' ? 'eigen_goed' : 'eigen_weg', platform: null, theme: null, v });
    }
  } catch (e) {
    waarschuwingen.push(`beoordelingen niet gelezen: ${(e as Error).message?.slice(0, 120)}`);
  }

  try {
    const { data: clips, error } = await supabase
      .from('clips')
      .select('platform, theme, render_job_id, render_bestand, clip_performance(outlier_score)')
      .eq('status', 'posted')
      .not('render_job_id', 'is', null);
    if (error) throw error;
    await leesRenders((clips ?? []).map((c) => c.render_job_id as string));
    for (const c of clips ?? []) {
      const perf = c.clip_performance as { outlier_score?: number | null } | { outlier_score?: number | null }[] | null;
      const score = (Array.isArray(perf) ? perf[0] : perf)?.outlier_score;
      if (typeof score !== 'number') continue;
      const groep: Groep | null = score >= EIGEN_GOED_SCORE ? 'eigen_goed' : score <= EIGEN_WEG_SCORE ? 'eigen_weg' : null;
      const v = vingerVan.get(`${c.render_job_id}|${c.render_bestand}`);
      if (groep && v) metingen.push({ groep, platform: c.platform as string | null, theme: c.theme as string | null, v });
    }
  } catch (e) {
    waarschuwingen.push(`eigen posts niet gelezen: ${(e as Error).message?.slice(0, 120)}`);
  }

  return { metingen, waarschuwingen };
}

/**
 * Puur: wie maakte deze post. De handle uit de URL, want zoek- en
 * trendingvondsten hebben geen tracked_account_id terwijl de basislijn die
 * wel heeft — op de handle vallen ze samen. Platform erbij: dezelfde naam op
 * TikTok en YouTube is niet per se dezelfde maker.
 */
export function accountSleutel(postUrl: string | null, trackedAccountId: string | null): string | null {
  const handle = postUrl?.match(/\/@([^/?#]+)/)?.[1]?.toLowerCase();
  if (handle) {
    const platform = /tiktok\.com/.test(postUrl!) ? 'tiktok' : /youtube\.com|youtu\.be/.test(postUrl!) ? 'yt' : /instagram\.com/.test(postUrl!) ? 'ig' : 'x';
    return `${platform}:${handle}`;
  }
  return trackedAccountId ? `id:${trackedAccountId}` : null;
}

/** Puur: welke (platform, theme)-groepen krijgen een rij, en welke metingen horen erin. */
export function groepeer(metingen: Meting[]): Map<string, Meting[]> {
  const groepen = new Map<string, Meting[]>();
  const voegToe = (p: string, t: string, m: Meting) => {
    const k = `${p}|${t}`;
    if (!groepen.has(k)) groepen.set(k, []);
    groepen.get(k)!.push(m);
  };
  for (const m of metingen) {
    voegToe('all', 'all', m);
    if (m.platform) voegToe(m.platform, 'all', m);
    if (m.theme) voegToe('all', m.theme, m);
    if (m.platform && m.theme) voegToe(m.platform, m.theme, m);
  }
  return groepen;
}

/**
 * Herberekent de normen en schrijft per groep een nieuwe edit_normen-rij.
 * Nieuwe rijen in plaats van updaten: zo is terug te zien hoe een norm
 * verschuift naarmate er meer gemeten wordt.
 */
export async function herberekenNormen(): Promise<{
  rijen: { platform: string; theme: string; n_top: number; n_basis: number; n_eigen: number; bron: EditDoelen['bron']; normen: number }[];
  waarschuwingen: string[];
}> {
  const { metingen, waarschuwingen } = await laadMetingen();
  const rijen: Awaited<ReturnType<typeof herberekenNormen>>['rijen'] = [];
  const insert: Record<string, unknown>[] = [];
  for (const [k, groep] of groepeer(metingen)) {
    const [platform, theme] = k.split('|');
    const nTop = groep.filter((m) => m.groep === 'top').length;
    const nBasis = groep.filter((m) => m.groep === 'basis').length;
    const nEigen = groep.filter((m) => m.groep === 'eigen_goed' || m.groep === 'eigen_weg').length;
    // Een groep met alleen top óf alleen basis kan niets vergelijken; de
    // rij zou alleen ruis in de tabel zijn.
    if (!(nTop > 0 && nBasis > 0) && nEigen === 0) continue;
    const normen = aggregeerNormen(groep);
    const doelen = doelenUitNormen(normen, groep.length);
    insert.push({ platform, theme, normen, doelen, n_top: nTop, n_basis: nBasis, n_eigen: nEigen });
    rijen.push({
      platform, theme, n_top: nTop, n_basis: nBasis, n_eigen: nEigen, bron: doelen.bron,
      normen: Object.values(normen).filter((n) => n?.norm_extern || n?.norm_eigen).length,
    });
  }
  if (insert.length > 0) {
    const { error } = await db().from('edit_normen').insert(insert);
    if (error) throw new Error(`edit_normen schrijven: ${error.message}`);
  }
  wisNormCache();
  return { rijen, waarschuwingen };
}

function rond(n: number | null): number | null {
  return n === null ? null : Math.round(n * 1000) / 1000;
}
