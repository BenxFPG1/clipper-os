/**
 * Eén plek voor alle drempels die het beeld en het geluid van een montage
 * bepalen.
 *
 * Waarom: elk getal hieronder is ooit met de hand getuned op één bron, en de
 * geschiedenis daarvan stond verspreid in commentaren over zes bestanden. Als
 * een clip er slecht uitzag was niet na te gaan wélke drempel dat had
 * veroorzaakt, laat staan hem te variëren zonder code te wijzigen. Nu:
 *
 *  - elke waarde is via een env-variabele te overschrijven (MONTAGE_<NAAM>),
 *    zodat een experiment in CI geen commit vraagt;
 *  - `gebruikteInstellingen()` levert de set die in déze run gold, en de
 *    worker schrijft die mee in `clip_plans.montageplan` — de evaluatieset kan
 *    zo een slechte clip aan een drempel koppelen.
 *
 * De getallen zelf zijn ongewijzigd ten opzichte van waar ze vandaan komen;
 * dit bestand verandert niets aan het gedrag, alleen aan waar het staat.
 */

const STANDAARD = {
  /** Zoom: het hoofd hoort bijna de halve uitsnedebreedte te dragen. */
  ZOOM_GEWENST_HOOFDBREEDTE: 0.45,
  /** Verder inzoomen dan dit kost zichtbaar scherpte. */
  ZOOM_MAX: 1.7,
  /** Schaalverschil dat een naadknip als bewuste punch-in laat lezen. */
  ZOOM_NAADBUMP: 0.12,
  /** Onder dit schaalverschil leest een naad als "niet smooth". */
  ZOOM_NAAD_MIN_VERSCHIL: 0.08,
  /** Animatie van punch_in / snelle_zoom: doelschaal en aanlooptijd (s). */
  PUNCH_IN_SCHAAL: 1.12,
  PUNCH_IN_DUUR: 0.3,
  SNELLE_ZOOM_SCHAAL: 1.18,
  SNELLE_ZOOM_DUUR: 0.2,

  /** Kadercontrole: marge rond het gezichtsvak die binnen de uitsnede moet vallen. */
  KADER_MARGE: 0.35,
  /** Keuring: hoe ver het hoofd uit het midden mag staan (fractie uitsnede). */
  KEURING_UIT_MIDDEN_MAX: 0.14,
  /** Keuring: hoeveel van het hoofd buiten beeld mag vallen (fractie hoofdbreedte). */
  KEURING_BUITEN_MAX: 0.15,
  /** Keuring: metingen verder dan dit van de shot-mediaan zijn "de andere persoon". */
  KEURING_ANDERE_PERSOON: 0.28,
  /** Keuring: boven dit aandeel genegeerde metingen is de regel niet goed. */
  KEURING_MAX_GENEGEERD: 0.3,

  /** Snap: kortere dipjes zijn medeklinkers, geen pauzes. */
  SNAP_MIN_PAUZE: 0.25,
  /** Dode lucht: interne stiltes langer dan dit worden strakgetrokken… */
  DODE_LUCHT_MAX_STILTE: 1.1,
  /** …tot deze lengte. */
  DODE_LUCHT_LAAT: 0.55,

  /** Poort: ademruimte vóór en ná een knip (s). */
  POORT_ADEM_VOOR: 0.12,
  POORT_ADEM_NA: 0.2,
  /** Poort: onder deze lengte bestaat een segment niet. */
  POORT_MIN_SEGMENT: 0.6,

  /** Knipcontrole: boven dit niveau is een knippunt "middenin de spraak". */
  KNIP_DREMPEL_DB: -38,
  /** Knipcontrole: hoe lang we luisteren aan de buitenkant van de knip. */
  KNIP_VENSTER: 0.16,

  /** Audio: hoe lang het geluid van twee shots over elkaar loopt. */
  CROSSFADE: 0.14,
  /** Muziek: basisvolume zonder emotiecurve, en het bereik mét. */
  MUZIEK_BASIS: 0.34,
  MUZIEK_RUSTIG: 0.4,
  MUZIEK_SPANNING_BEREIK: 0.18,
  /** Muziek: ramp naar stilte vóór een payoff en terug erna (s). */
  MUZIEK_RAMP_UIT: 0.25,
  MUZIEK_RAMP_IN: 0.35,

  /** Hookkaart: minimale duur en leestijd per woord (s). */
  HOOK_MIN_DUUR: 2.2,
  HOOK_SECONDEN_PER_WOORD: 0.35,

  /** Ondertitels: woorden per regel en de pauze waarop een regel breekt (s). */
  ONDERTITEL_MAX_WOORDEN: 4,
  ONDERTITEL_MAX_TEKENS: 22,
  ONDERTITEL_BREEK_PAUZE: 0.6,
} as const;

export type InstellingNaam = keyof typeof STANDAARD;

const cache = new Map<InstellingNaam, number>();

/**
 * De waarde van één instelling: uit de omgeving als `MONTAGE_<NAAM>` gezet en
 * een getal is, anders de standaard.
 */
export function instelling(naam: InstellingNaam): number {
  const hit = cache.get(naam);
  if (hit !== undefined) return hit;
  const ruw = process.env[`MONTAGE_${naam}`];
  const n = ruw === undefined ? NaN : Number(ruw);
  const waarde = Number.isFinite(n) ? n : STANDAARD[naam];
  cache.set(naam, waarde);
  return waarde;
}

/** Alle instellingen zoals ze in deze run gelden; gaat mee in het montageplan. */
export function gebruikteInstellingen(): Record<InstellingNaam, number> {
  const uit = {} as Record<InstellingNaam, number>;
  for (const naam of Object.keys(STANDAARD) as InstellingNaam[]) uit[naam] = instelling(naam);
  return uit;
}

/** Welke instellingen afwijken van de standaard — handig in de log. */
export function afwijkendeInstellingen(): string[] {
  return (Object.keys(STANDAARD) as InstellingNaam[])
    .filter((naam) => instelling(naam) !== STANDAARD[naam])
    .map((naam) => `${naam}=${instelling(naam)} (standaard ${STANDAARD[naam]})`);
}
