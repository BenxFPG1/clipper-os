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
  /**
   * Tijdsbudget (s) per clip voor het opnieuw transcriberen van de gebruikte
   * bereiken met het grotere model (ondertitelwoorden.ts). Wat er niet in
   * past, houdt de 'small'-woorden.
   */
  ONDERTITEL_MODEL_BUDGET: 150,
  /**
   * Brontranscriptie per bereik (woorden.ts): marge (s) rond de shots van de
   * opdracht, en de time-out als veelvoud van de audioduur (minimaal 120 s).
   */
  BRON_BEREIK_MARGE: 20,
  /**
   * Actieve-sprekerdetectie (sprekers.ts): meetstap (s), beslisvenster (s),
   * hoe lang een spreker minstens in beeld blijft (hysterese, s), kortste
   * deel bij een sprekerwissel en bij een camerawissel (s), hoe ver een
   * sprekerwissel naar een woordgrens mag schuiven (s), de duur van een
   * snelle pan (s) en de maximale breedte van een tweeshot (fractie).
   */
  SPREKER_STAP: 0.1,
  /** Zelfherstel op de spreker: vanaf welk aandeel hoofd buiten beeld / afwijking van het midden het kader verplaatst wordt. */
  ZELFHERSTEL_SPREKER_BUITEN: 0.25,
  ZELFHERSTEL_SPREKER_MIDDEN: 0.2,
  /** Tweeshot alleen als elk gezicht minstens dit aandeel van de beeldbreedte (9:16) krijgt. */
  TWEESHOT_MIN_GEZICHT: 0.12,
  /**
   * Scherp begin (Laplacian-variantie, gezichtsuitsnede op 160 px): onder deze
   * waarde is een gezicht onscherp. Gemeten: scherpe gezichten 56–86,
   * bewegingsonscherpte/zwiep 4–15. Beeld als geheel: zwiep 40–80, normaal 250+.
   */
  SCHERP_MIN_GEZICHT: 18,
  SCHERP_MIN_BEELD: 120,
  /** Hoogstens zoveel seconden aan het begin bevriezen op het eerste scherpe frame. */
  SCHERP_BEVRIES_MAX: 0.6,
  SPREKER_VENSTER: 0.5,
  SPREKER_MIN_VAST: 1.2,
  SPREKER_MIN_DEEL: 0.6,
  SPREKER_MIN_STANDPUNT: 0.25,
  SPREKER_WOORDGRENS_MARGE: 0.4,
  SPREKER_PAN_DUUR: 0.3,
  SPREKER_TWEESHOT_MAX: 0.3,
  BRON_TRANSCRIPTIE_TIJDFACTOR: 3,
  ONDERTITEL_RAND: 7,
  ONDERTITEL_SCHADUW: 3,
  /** Maximale regelbreedte in px; een langere regel wordt smaller geschaald in plaats van afgebroken. */
  ONDERTITEL_MAX_BREEDTE: 960,
  /** Standaardhoogte van het regelmidden (fractie), en de onderrand die nooit gepasseerd wordt (TikTok-UI). */
  ONDERTITEL_Y: 0.72,
  ONDERTITEL_Y_MAX: 0.78,
  /** Noodgrens: past het onder de kin net niet, dan mag de regel tot hier zakken (nog boven de platformknoppen). */
  ONDERTITEL_Y_MAX_NOOD: 0.8,
  /** Past ook dat niet, dan eerst de regel zoveel kleiner (fractie) voordat hij boven het hoofd gaat. */
  ONDERTITEL_KLEINER: 0.85,
  /** Ruimte tussen kin en ondertitel (fractie van de hoogte). */
  ONDERTITEL_KIN_MARGE: 0.015,
  /** Boven het hoofd mag een regel alleen als hij dan niet in de hookzone valt (fractie). */
  ONDERTITEL_Y_MIN_BOVEN: 0.3,
  /** Tekstkaarten (context, re-hook, uitvalrisico): bovenkant van de balk (fractie), onder de hookzone. */
  KAART_Y: 0.19,

  /** Scènewissels in de bron: drempel van ffmpeg's scene-score, en de kortste deelstuklengte (s). */
  SCENE_DREMPEL: 0.3,
  SCENE_MIN_DEEL: 0.4,
  /**
   * Gezichtsaanwezigheid is de primaire bron voor deelstukken (een overvloeier
   * naar een graphic heeft geen harde knip): elke SCENE_STAP s meten, runs
   * korter dan SCENE_GAT_GLAD gladstrijken, en het wisselmoment op de hoogste
   * scènescore binnen ±SCENE_OVERGANG_MARGE rond de overgang (onder
   * SCENE_PIEK_MIN geen piek: het midden).
   */
  SCENE_STAP: 0.4,
  /**
   * Wissel van de ene graphic naar de volgende (scenes.ts graphicWissels):
   * beeldverschil (0..255, 96x54 grijs) waaronder een frame stilstaat, het
   * verschil tussen twee stilstaande stukken waarboven het twee graphics zijn,
   * en de minimale afstand (s) tussen wissels en tot de randen.
   */
  SCENE_GRAPHIC_STIL: 1.5,
  SCENE_GRAPHIC_ANDERS: 6,
  SCENE_GRAPHIC_MIN_AFSTAND: 0.8,
  SCENE_GAT_GLAD: 0.6,
  SCENE_OVERGANG_MARGE: 0.5,
  SCENE_PIEK_MIN: 0.02,

  /**
   * Graphics met gemeten inhoud (graphics.ts): kleurafstand tot de
   * achtergrond waarboven een pixel inhoud is, het minimale aandeel egale
   * achtergrond voor een betrouwbare meting, de marge rond de inhoud, en de
   * maximale inzoom ten opzichte van een 1080p-bron.
   */
  /** Een beeld zonder gezicht is pas een graphic als minstens dit aandeel vlak is; anders is het een wijd camerashot. */
  GRAPHIC_MIN_VLAK: 0.62,
  /**
   * Een graphic heeft (bijna) geen zachte verlopen: aandeel pixels met een
   * zachte helderheidsgradiënt (8–60 op 0–255). Gemeten: graphics 0,04;
   * camerabeelden 0,12–0,28 (ook een donkere, egale kantoormuur: 0,12).
   */
  GRAPHIC_MAX_ZACHT: 0.1,
  /** Een lichte pagina vol tekst (website, document) is ook een graphic: minimale helderheid en aandeel harde randen. */
  GRAPHIC_PAGINA_LUM: 120,
  GRAPHIC_PAGINA_HARD: 0.06,
  /** Kleinste gezichtsbreedte (fractie) waarbij een moment als persoonsbeeld telt; kleiner beslist de graphic-meter. */
  SCENE_MIN_GEZICHT: 0.04,
  /** De inhoud van het eerste en het laatste meetframe moet elk minstens dit aandeel van de unie beslaan, anders animeert de graphic en wordt er niet ingezoomd. */
  GRAPHIC_MIN_STABIEL: 0.7,
  /** Milde inzoom op een animerende graphic: alleen als er rondom minstens zoveel egale marge is (fractie). */
  GRAPHIC_MIN_MARGE: 0.05,
  /** Zelfherstel: zoveel extra render-en-keurrondes voor graphics en eindscherm. */
  ZELFHERSTEL_RONDES: 2,
  GRAPHIC_KLEUR_DREMPEL: 36,
  GRAPHIC_MIN_ACHTERGROND: 0.4,
  /** Randsterkte (Sobel op helderheid, 0..~1400) waarboven een pixel tot tekst of een lijn hoort. */
  GRAPHIC_RAND_DREMPEL: 160,
  /** Een klein los element binnen deze fractie van een hoek is een logo/watermerk en mag buiten beeld. */
  GRAPHIC_HOEK: 0.25,
  GRAPHIC_MARGE: 0.06,
  GRAPHIC_MAX_OPSCHAAL: 3,

  /**
   * Renderbron (renderbron.ts): alleen de stukken die de clip gebruikt, in de
   * hoogste kwaliteit. Marge per kant (s), samenvoegen bij een gat kleiner dan
   * dit (s), maximale hoogte, time-out per sectie (s), en de minimale
   * correlatie waarmee de audio-uitlijning vertrouwd wordt.
   */
  RENDERBRON_MARGE: 2,
  /** Gecachete bronnen en secties in R2 (bron/<videoId>/…) worden na zoveel dagen opgeruimd. */
  BRONCACHE_DAGEN: 14,
  RENDERBRON_SAMENVOEG_GAT: 15,
  RENDERBRON_MAX_HOOGTE: 2160,
  RENDERBRON_TIMEOUT: 300,
  RENDERBRON_MIN_CORRELATIE: 0.6,
  /** Zekerheid (0..1) waarboven de apart gemeten beeldoffset van een sectie de geluidsoffset overrulet. */
  RENDERBRON_BEELD_ZEKERHEID: 0.25,

  /**
   * Leestijd van graphics: basis plus per leeseenheid (woord, getal), met een
   * terugval als er niet geteld kon worden en een plafond. Is een graphic in
   * de bron korter, dan blijft hij staan (laatste frame) terwijl het geluid
   * doorloopt — hoogstens GRAPHIC_MAX_HOLD, en de spreker nooit langer dan
   * GRAPHIC_MAX_ONZICHTBAAR weg als er een punchline (payoff/barst) volgt;
   * van het volgende deelstuk blijft minstens GRAPHIC_MIN_REST over.
   */
  GRAPHIC_LEES_BASIS: 1.2,
  GRAPHIC_LEES_PER_WOORD: 0.25,
  GRAPHIC_LEES_TERUGVAL_WOORDEN: 4,
  GRAPHIC_LEES_MAX: 4,
  GRAPHIC_MAX_HOLD: 2.5,
  /** Een blok graphics direct na elkaar mag samen hoogstens zoveel vertraging oplopen (beeld achter op geluid). */
  GRAPHIC_MAX_BLOK_VERTRAGING: 3,
  // Korter dan dit in de bron is een overgang (wipe, sectietitel), geen
  // bedoeld leesmoment: de maker van de bron liet hem zelf maar zo kort staan.
  // Niet verlengen en niet als leesbaarheidsfout tellen. 1,2 s liet een
  // sectietitel van precies 1,2 s door (PLATINA clip 1).
  GRAPHIC_MIN_VOOR_LEESTIJD: 1.5,
  // Aandeel van de leestijd dat een graphic minstens in beeld moet zijn om als
  // leesbaar te gelden in de keuring.
  GRAPHIC_LEES_GENOEG: 0.8,
  GRAPHIC_MAX_ONZICHTBAAR: 3,
  GRAPHIC_MIN_REST: 0.8,

  /** Eindscherm: alleen in de laatste zoveel seconden van de bron zoeken naar abonneer-overlays. */
  EINDSCHERM_VENSTER: 30,

  /**
   * Afwerking (afwerking.ts). Elk onderdeel staat aan met 1 en uit met 0, en
   * is per campagne uit te zetten via huisstijl.afwerking.<onderdeel> = false.
   */
  AFWERKING_EASING: 1,
  AFWERKING_HIT: 1,
  AFWERKING_KLEUR: 1,
  AFWERKING_STEM: 1,
  AFWERKING_SFX: 1,
  AFWERKING_MUZIEK: 1,
  AFWERKING_JL: 1,
  /** Een retentie-kaderwissel als zachte push in plaats van een harde sprong (s). */
  RETENTIE_WISSEL_DUUR: 0.25,
  /** Hit-zoom op het payoff-woord: schaal, aanloop en terugweg (s). */
  HIT_SCHAAL: 1.08,
  HIT_IN: 0.08,
  HIT_UIT: 0.3,
  /** Kleurcorrectie: doel-gemiddelde helderheid (0–255), maximaal contrast en verzadiging. */
  KLEUR_DOEL_YAVG: 116,
  KLEUR_MAX_CONTRAST: 1.12,
  KLEUR_VERZADIGING: 1.06,
  /** Sound design: minimale afstand tussen twee effecten (s) en hun volume onder de stem. */
  SFX_MIN_AFSTAND: 3,
  SFX_VOLUME: 0.16,
  /** Muziek: hoeveel harder het bed na de hook mag (factor) en hoe ver een knip naar een beat mag schuiven (s). */
  MUZIEK_NA_HOOK: 1.25,
  BEAT_MAX_VERSCHUIF: 0.12,
  /** J/L-cut: hoe ver het geluid vóór- of na-ijlt op een wissel (s). */
  JL_DUUR: 0.2,
  /** Crossfade op een weggeknipte pauze (s): kort, zodat er geen tik of plotse stilte is. */
  PAUZE_CROSSFADE: 0.03,
  /** Na een zinseinde blijft er zoveel adem staan (s) als de pauze wordt ingekort. */
  RETENTIE_PAUZE_REST_ZIN: 0.22,

  /** Opschalen: vanaf deze factor een milde verscherping (lanczos schaalt altijd). */
  OPSCHAAL_VERSCHERP_VANAF: 1.1,
  /**
   * Analysebron: de hele video, alleen voor meten (gezichten, scènes,
   * woordtijden, stiltes). 1080p H.264 is ruim genoeg; alle metingen zijn
   * genormaliseerd. Scherpte komt uit de renderbron (renderbron.ts).
   */
  BRON_MAX_HOOGTE: 1080,

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

/** Ondertitelstijl-preset: 'pop' (standaard), 'strak' of 'karaoke'. */
export type OndertitelStijl = 'pop' | 'strak' | 'karaoke';
export function ondertitelStijlStandaard(): OndertitelStijl {
  const s = process.env.MONTAGE_ONDERTITEL_STIJL;
  return s === 'strak' || s === 'karaoke' ? s : 'pop';
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
