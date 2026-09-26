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
  ONDERTITEL_MAX_WOORDEN: 3,
  ONDERTITEL_MAX_TEKENS: 14,
  ONDERTITEL_BREEK_PAUZE: 0.6,
  /**
   * Ondertitelstijl (eigen stijl, los van het kaartfont): kapitaalhoogte in px
   * op 1080x1920, dikte van de zwarte rand en de schaduw. 35 px bleek op een
   * telefoon onleesbaar; 60-70 is wat top-clips doen.
   */
  ONDERTITEL_KAPHOOGTE: 64,
  ONDERTITEL_RAND: 7,
  ONDERTITEL_SCHADUW: 3,
  /** Maximale regelbreedte in px; een langere regel wordt smaller geschaald in plaats van afgebroken. */
  ONDERTITEL_MAX_BREEDTE: 960,
  /** Standaardhoogte van het regelmidden (fractie), en de onderrand die nooit gepasseerd wordt (TikTok-UI). */
  ONDERTITEL_Y: 0.72,
  ONDERTITEL_Y_MAX: 0.78,
  /** Ruimte tussen kin en ondertitel (fractie van de hoogte). */
  ONDERTITEL_KIN_MARGE: 0.015,
  /** Boven het hoofd mag een regel alleen als hij dan niet in de hookzone valt (fractie). */
  ONDERTITEL_Y_MIN_BOVEN: 0.3,
  /** Tekstkaarten (context, re-hook, uitvalrisico): bovenkant van de balk (fractie), onder de hookzone. */
  KAART_Y: 0.19,

  /** Scènewissels in de bron: drempel van ffmpeg's scene-score, en de kortste deelstuklengte (s). */
  SCENE_DREMPEL: 0.3,
  SCENE_MIN_DEEL: 0.4,

  /** Opschalen: vanaf deze factor een milde verscherping (lanczos schaalt altijd). */
  OPSCHAAL_VERSCHERP_VANAF: 1.1,
  /** Bron: hoogste resolutie die gedownload wordt (niet-AV1; YouTube levert boven 1080p geen H.264). */
  BRON_MAX_HOOGTE: 1440,

  /**
   * Encode van het eindbestand. Platforms her-encoden altijd; een master op
   * 0,9 Mbps wordt daar blokkerig. CRF 17 op medium met een plafond: het
   * maxBytes-plafond van de opslag blijft de bovengrens winnen.
   */
  ENCODE_CRF: 17,
  ENCODE_MAXRATE: 12_000_000,
  ENCODE_BUFSIZE: 24_000_000,
  /** Het tussenbestand waar de hookkaarten nog overheen gaan: bijna verliesvrij, zodat de tweede encode niets opstapelt. */
  ENCODE_CRF_TUSSEN: 12,

  /**
   * Retentie-editor (retentie.ts). De doelen zelf (max pauze, max tijd zonder
   * beeldwissel, eerste wissel) komen uit editDoelen() — gemeten bij anderen;
   * dit zijn alleen de knoppen van het gereedschap dat ze uitvoert.
   */
  /** Resolutie van de risicocurve (s). */
  RETENTIE_STAP: 0.5,
  /** De eerste seconden wegen zwaarder: daar valt de swipe-beslissing. */
  RETENTIE_EERSTE_SECONDEN: 3,
  RETENTIE_EERSTE_GEWICHT: 1.5,
  /** Hoeveel stilte er na een pauze-jumpcut blijft staan (s, beide kanten samen). */
  RETENTIE_PAUZE_REST: 0.16,
  /** Een deel korter dan dit ontstaat niet door een retentieknip (s); de poort gooit < 0,6 weg. */
  RETENTIE_MIN_DEEL: 0.8,
  /** In een payoff-shot is een pauze tot deze lengte spanning, geen dode lucht (s). */
  RETENTIE_PAYOFF_PAUZE_MAX: 1.2,
  /** …maar alleen in de eerste seconden van dat shot, rond de onthulling zelf; daarna is een pauze gewoon een pauze. */
  RETENTIE_PAYOFF_VENSTER: 3,
  /** Zoekvenster vóór de deadline waarin een kaderwissel op een woordgrens mag vallen (s). */
  RETENTIE_WISSEL_VENSTER: 1.5,
  /** Vanaf deze afstand tot de payoff telt "wachten op de payoff" volledig als risico (s). */
  RETENTIE_PAYOFF_HORIZON: 12,
  /** Een re-hookkaart alleen als hook en payoff minstens zo ver uit elkaar liggen (s). */
  RETENTIE_REHOOK_MIN_AANLOOP: 8,
  RETENTIE_REHOOK_DUUR: 2,
  /** …en alleen in een venster met minstens dit gemiddelde risico (0..1); anders is er geen gat te dichten. */
  RETENTIE_REHOOK_MIN_RISICO: 0.25,
  /** Gewichten van de risicocomponenten (som hoeft niet 1 te zijn; de curve wordt op 1 geklemd). */
  RETENTIE_W_PAUZE: 0.3,
  RETENTIE_W_BEELD: 0.25,
  RETENTIE_W_TEKST: 0.15,
  RETENTIE_W_LEEG: 0.15,
  RETENTIE_W_PAYOFF: 0.15,
  /** Keuring: een gat mag zoveel keer het doel zijn voordat het "review nodig" wordt. */
  RETENTIE_KEURING_MARGE: 1.25,
  /** Keuring: zoveel pauzes boven het doel mogen blijven staan (niet te knippen zonder een te kort deel). */
  RETENTIE_KEURING_MAX_PAUZES: 1,
} as const;

export type InstellingNaam = keyof typeof STANDAARD;

/**
 * De x264-preset is geen getal en staat daarom apart, met dezelfde
 * overschrijfbaarheid (MONTAGE_ENCODE_PRESET). Voor tussenbestanden altijd
 * snel: die zijn bijna verliesvrij en worden niet geüpload.
 */
export function encodePreset(): string {
  return process.env.MONTAGE_ENCODE_PRESET || 'medium';
}

/** Standaard ondertitelfont (sleutel in FONTS): dik, schreefloos en statisch, zodat libass het zeker laadt. */
export function ondertitelFontStandaard(): string {
  return process.env.MONTAGE_ONDERTITEL_FONT || 'archivo';
}

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
