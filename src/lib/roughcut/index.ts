import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { voerYtdlpUit } from '../ingest/youtube';
import { effectKeten, focusNaarX, kaderKeten, opschaalFactor, spoorExpressie, type Kader } from './kader';
import { snapShots, verwijderDodeLucht, type SnapSegment, type Stilte } from './snap';
import { encodePreset, instelling } from './instellingen';
import { assFilter } from './ondertitels';
import { deelstukken, type Scene } from './scenes';
import { inhoudKader, schaalTovPassend } from './graphics';
import { bewaarInBronCache, bronSleutel, haalUitBronCache } from './broncache';
import { leesLogregel, leestijdPlan } from './leestijd';
import { haalRenderSecties, sectieBeeldTijd, sectiePlan, sectieTijd, sectieVoor, type RenderBron } from './renderbron';

export type Shot = {
  volgorde: number;
  start: number;
  end: number;
  functie: string;
  edit_notitie?: string;
  sfx?: string;
  /** Uit het plan: waar het verticale kader op richt. */
  focus?: 'links' | 'midden' | 'rechts';
  /** Gemeten gezichtspositie (0..1) uit de gezichtsdetectie. */
  focusX?: number;
  /** Gemeten gezichtsbreedte als fractie van het beeld; begrenst de zoom. */
  focusW?: number;
  /** Kleinste gemeten gezichtsbreedte binnen het shot (wegleun-momenten). */
  focusWmin?: number;
  /** Hoe ver de spreker binnen dit shot horizontaal beweegt (fractie). */
  spreiding?: number;
  /**
   * Meelopend focuspunt: waar de spreker staat op welk moment binnen dit shot,
   * al gladgestreken. Is dit gezet, dan beweegt de uitsnede mee in plaats van
   * uit te zoomen tot alles past.
   */
  spoor?: { t: number; x: number }[];
  /** Verticaal meelopend kader (ooghoogte); zelfde vorm als het spoor. */
  spoorY?: { t: number; x: number }[];
  /** Grootste sprong tussen twee opeenvolgende ruwe metingen: onderscheidt een
   * sprekerswissel (sprong) van een wegleunende spreker (glijer). */
  maxStap?: number;
  /**
   * De bron is hier zelf een split screen; dit is het deel [van, tot] waar de
   * spreker in staat. Daarbuiten kadreren levert een halve persoon plus een
   * naad op.
   */
  paneel?: [number, number];
  /** Verticale plek van het uitsnedemidden (0..1); regelt de hoofdruimte. */
  focusY?: number;
  /** Door de kadercontrole vastgestelde zoom; overschrijft de effect-zoom. */
  zoom?: number;
  /**
   * De knip valt onvermijdelijk middenin spraak (er is geen pauze in de buurt).
   * Dan een langere audiofade: dat leest als een bewuste zachte overgang in
   * plaats van een afgebroken woord.
   */
  zachtBegin?: boolean;
  zachtEind?: boolean;
  /**
   * Grens bewust strak gezet door de retentie-editor (een pauze-jumpcut of
   * een kaderwissel binnen doorlopende spraak). De rest-stilte is daar al
   * gekozen; de poort mag hier geen ademruimte meer bijtellen, anders groeit
   * de weggeknipte pauze elke poortronde weer een stukje terug.
   */
  strakBegin?: boolean;
  strakEind?: boolean;
  /** De grenzen zoals het plan ze bedoelde, vóór uitlijning en verschuiving.
   * Het reddingspunt: blijkt uit de terugluistering dat de eerste woorden van
   * het fragment ontbreken, dan is dít waar we naar teruggrijpen. */
  planStart?: number;
  planEnd?: number;
  /**
   * Begin en eind van het scriptfragment zoals teruggevonden in de
   * brontranscriptie, op het woord nauwkeurig. Dit is de maat voor "de zin is
   * compleet": eindigt een shot vóór ankerEind, dan is de zin afgekapt.
   */
  ankerStart?: number;
  ankerEind?: number;
  /**
   * Grenzen komen exact van de brontranscriptie (woordanker). Dan is elke
   * verdere verschuiving per definitie een verslechtering: snap en
   * knipcontrole blijven eraf.
   */
  exact?: boolean;
  /** Gemeten gezichtsvak, waartegen de kadercontrole toetst. */
  gezicht?: { x: number; breedte: number; top: number; hoogte: number };
  /**
   * Meerdere mensen ver uit elkaar in beeld, zonder duidelijke spreker. Dan mag
   * er niet strak gekadreerd of ingezoomd worden: dan valt de uitsnede precies
   * tussen twee hoofden in.
   */
  breed?: boolean;
  /**
   * Kader bepaald door de actieve-sprekerdetectie (sprekers.ts): focus,
   * breedte en spoor horen bij de persoon die praat. De oude
   * één-gezicht-meting en het spoor mogen dit niet meer overschrijven.
   */
  sprekerBepaald?: boolean;
  /**
   * Scherp begin (scherpbegin.ts): de eerste `tot` seconden van dit shot
   * tonen het (verwerkte) frame op brontijd `bron` bevroren; het geluid loopt
   * gewoon door. Alleen op het eerste shot van de clip.
   */
  bevriesBegin?: { tot: number; bron: number };
  beeld_effect?: string;
  /**
   * De emotiecurve (bouwsteen D), 1-10, uit het plan. Stuurt de muziek-
   * ducking bij: rustige shots laten iets meer bed door, shots die een piek
   * moeten voelen duiken dieper weg. Ontbreekt dit (oudere plannen), dan
   * blijft de vaste 0,34 van vroeger gewoon gelden — geen gedragswijziging.
   */
  spanning?: number;
  /**
   * Korte cold open die de payoff bewust vooruit laat horen. De poort en de
   * keuring staan dit gedeelde bronmateriaal toe; alles zonder deze vlag niet.
   */
  tease?: boolean;
  /** De regel op de tekstkaart bij dit shot (van de edit-agent); null = geen kaart. */
  tekstkaart?: string | null;
  /** Aantal personen dat de gezichtsdetectie in dit shot zag. */
  personen?: number;
  /** Ontstaan door een split (dode lucht, sprekerswissel); erft van zijn bronshot. */
  subKnip?: boolean;
  /**
   * Wat er in beeld staat volgens de visuele controle. Bij 'graphic' (een
   * titel, grafiek, schermopname) wordt niet op een gezicht gekadreerd maar
   * passend gemaakt: het hele beeld, met een geblurde achtergrond.
   */
  beeldtype?: 'persoon' | 'graphic' | 'gemengd';
  /**
   * De scènes van de bron binnen dit shot (absolute brontijd), met per scène
   * of er een gezicht in staat. Knipt de bron binnen één shot van spreker naar
   * graphic, dan wisselt het kader op precies die bronknip (scenes.ts).
   */
  scenes?: Scene[];
  /**
   * Afwerking (afwerking.ts / sounddesign.ts): een "hit"-zoom op deze seconde
   * binnen het shot (het payoff-woord); een retentie-kaderwissel die als
   * zachte push binnenkomt; en een J/L-verschuiving van het geluid op de naad
   * ná dit shot (negatief = het volgende geluid begint eerder, J-cut;
   * positief = dit geluid loopt door onder het volgende beeld, L-cut).
   */
  hit?: number;
  zachteWissel?: boolean;
  audioNaad?: number;
  /** Gemeten eindscherm-/abonneeroverlay (genormaliseerd, eindscherm.ts); het kader houdt die buiten beeld. */
  overlay?: { x0: number; y0: number; x1: number; y1: number };
  /** Brontijd waarop de overlay voor het eerst gezien is (voor inkorten bij zelfherstel). */
  overlayVanaf?: number;
};

export type BurnOverlay = {
  /** Absoluut pad naar een transparante PNG van 1080x1920. */
  pad: string;
  /** Zichtbaar van/tot, in seconden op de tijdlijn van de montage. */
  start: number;
  end: number;
};

export type BronEigenschappen = { fps: number; breedte: number; hoogte: number; codec?: string };

/** Meet framerate en afmetingen van een bronbestand met ffprobe. */
export async function probeBron(pad: string): Promise<BronEigenschappen> {
  const uit = await run(resolveBinary('ffprobe'), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,codec_name',
    '-of', 'json',
    pad,
  ]);
  const stream = (JSON.parse(uit).streams ?? [])[0] as {
    width: number;
    height: number;
    r_frame_rate: string;
    codec_name?: string;
  };
  const [t, n] = stream.r_frame_rate.split('/').map(Number);
  return { fps: n ? t / n : 25, breedte: stream.width, hoogte: stream.height, codec: stream.codec_name };
}

/**
 * Maakt een ruwe montage: de shots uit het plan achter elkaar geplakt, in
 * verticaal formaat, klaar om in CapCut te openen.
 *
 * Bewust rúw. De tool doet het mechanische werk — de juiste fragmenten in de
 * juiste volgorde — en laat alles waar oordeel voor nodig is (zooms, timing van
 * ondertitels, muziek, precieze in- en uitpunten) aan de editor. Zo blijft de
 * kennis waar hij hoort en vervalt alleen het knip- en plakwerk.
 */
/**
 * De broadcast-stemketen (afwerking 'stem'), vóór loudnorm. Los geëxporteerd
 * zodat de test exact deze keten meet (LUFS, geen pompen).
 */
export function stemKeten(ruisig: boolean): string {
  return (
    `highpass=f=80,afftdn=nf=${ruisig ? -24 : -30},deesser=i=0.35,` +
    `acompressor=threshold=0.089:ratio=2.5:attack=15:release=250:makeup=1.6:knee=4,` +
    `equalizer=f=3500:t=q:w=1.2:g=2`
  );
}

export async function maakRuweMontage(opties: {
  sourceUrl: string;
  shots: Shot[];
  outputPad: string;
  werkmap: string;
  verticaal?: boolean;
  /** Kadering; standaard 'staand' (geen blur, niets weggesneden). */
  kader?: Kader;
  /** Transcript en gemeten stiltes om knippen naar spraakgrenzen te schuiven. */
  transcript?: SnapSegment[];
  stiltes?: Stilte[];
  /**
   * Tekstkaarten en hookoverlay om in het beeld te branden. Posities gelden op
   * de uiteindelijke tijdlijn; gebruik de teruggegeven segmentlijst van een
   * eerdere droge run of laat de aanroeper ze na afloop berekenen via
   * `bepaalSegmenten`.
   */
  overlays?: BurnOverlay[];
  /** Shots zijn al door bepaalSegmenten gehaald; niet opnieuw knippen. */
  alGesegmenteerd?: boolean;
  /**
   * Ruisvloer in dBFS, gemeten tijdens de spraakpauzes van de bron. Boven de
   * -45 dB zit er muziek of ruis onder de spraak en zetten we de
   * ruisonderdrukking aan; daaronder is de bron schoon en zou hij alleen maar
   * schade aanrichten.
   */
  ruisvloerDb?: number | null;
  /** Muziekbed (pad naar eigen gelicenseerd bestand); geduckt onder de spraak. */
  muziekPad?: string;
  /** Map met sfx-bestanden (slug.wav/mp3); alleen aanwezige worden gemixt. */
  sfxMap?: string;
  /** Maximale bestandsgrootte; groter wordt automatisch gecomprimeerd. */
  maxBytes?: number;
  /** ASS-bestand met woordelijke ondertitels; ingebrand vóór de overlays. */
  ondertitelAss?: string;
  /**
   * Dit is een tussenbestand waar straks nog hookkaarten overheen gaan: dan
   * bijna verliesvrij (ENCODE_CRF_TUSSEN) en zonder bytesplafond, zodat de
   * tweede encode geen verlies op verlies stapelt.
   */
  tussenbestand?: boolean;
  /**
   * Render uit secties in de hoogste kwaliteit (renderbron.ts) in plaats van
   * uit de analysebron. Alleen voor een echte URL; mislukt een sectie, dan
   * rendert dat shot gewoon uit de analysebron.
   */
  renderSecties?: boolean;
  /** Al opgehaalde renderbron (tests, of een aanroeper die de secties zelf beheert); wint van renderSecties. */
  renderBron?: RenderBron;
  /** Video-id: dan worden 4K-secties ook in de R2-cache gezocht en bewaard. */
  videoId?: string;
  /** Afwerking: easing, kleur, stemketen, sound design en muziekdynamiek (afwerking.ts). Zonder: het oude gedrag. */
  afwerking?: RenderAfwerking;
  onVoortgang?: (bericht: string) => void;
}): Promise<{ pad: string; duur: number; bron: BronEigenschappen | null; kwaliteit: RenderKwaliteit }> {
  const { sourceUrl, shots, outputPad, werkmap } = opties;
  const log = opties.onVoortgang ?? (() => {});

  if (shots.length === 0) throw new Error('Geen shots om te monteren.');

  const bronBestand = await zorgVoorBron(sourceUrl, werkmap, log);

  // Eigenschappen van de bron meten; de aanroeper bewaart ze in de database
  // zodat het Premiere-projectbestand framerate-correct gegenereerd kan worden.
  let bronInfo: BronEigenschappen | null = null;
  try {
    bronInfo = await probeBron(bronBestand);
  } catch {
    // Niet fataal: de montage zelf heeft de meting niet nodig.
  }

  const gesorteerd = opties.alGesegmenteerd
    ? [...shots].sort((a, b) => a.volgorde - b.volgorde).filter((s) => s.end > s.start)
    : bepaalSegmenten(shots, opties);
  if (gesorteerd.length === 0) throw new Error('Alle shots hadden een ongeldige lengte.');

  const totaleDuur = gesorteerd.reduce((som, sh) => som + (sh.end - sh.start), 0);
  const totaal = totaleDuur;

  const encode = opties.tussenbestand
    ? encodeArgs({ tussen: true })
    : encodeArgs({ maxBytes: opties.maxBytes, duur: totaleDuur });

  const kader: Kader = opties.verticaal === false ? 'origineel' : (opties.kader ?? 'vullend');
  log(`Monteren in één doorloop (${gesorteerd.length} segmenten, kader: ${kader})…`);

  // De framerate van de bron aanhouden. Een vaste 30 op een 25 fps-bron
  // (gangbaar bij Nederlandse YouTube) dupliceert elke vijfde frame — dat
  // stottert zichtbaar bij een meelopend kader en bij de shake.
  const fpsUit = fpsVoorRender(bronInfo);

  // Bron per shot als eigen invoer met -ss vóór -i: ffmpeg springt dan direct
  // naar het fragment in plaats van de hele video te decoderen (dat werd op de
  // runner afgeschoten). Per shot een eigen kaderketen: focuspunt en punch-in
  // verschillen per shot.
  // Hoe lang de audio van twee shots over elkaar heen loopt. 0,14s is de
  // vuistregel uit de montagepraktijk: lang genoeg om een harde overgang te
  // verzachten, kort genoeg om geen echo of dubbele stem te horen.
  const OVERLAP = Number(process.env.CROSSFADE ?? instelling('CROSSFADE'));

  // De naadbump (punch-in op een jump cut) is al vóór de kadercontrole in
  // `shot.zoom` gezet (pasNaadZoomToe); hier wordt hij alleen nog uitgevoerd.
  // Eerder gebeurde dat pas hier in de render, onzichtbaar voor de
  // kadercontrole én de keuring — die toetsten dan een andere zoom dan er
  // werkelijk uitkwam.
  const invoer: string[] = [];
  const delenVideo: string[] = [];
  const delenAudio: string[] = [];
  const kwaliteit: RenderKwaliteit = { opschaalMax: 0, persoonDelen: 0, graphicDelen: 0, graphicsIngezoomd: 0, graphicSchalen: [], renderbron: null };
  const verhouding = bronInfo && bronInfo.hoogte > 0 ? bronInfo.breedte / bronInfo.hoogte : 16 / 9;

  // De renderbron: alleen de stukken die deze clip gebruikt, in de hoogste
  // kwaliteit. De handles voor de audio-crossfade horen erbij, en de
  // secties zijn ruim (marge per kant), zodat kleine grensverschuivingen
  // van latere correctierondes er nog in vallen.
  let renderBron: RenderBron | null = opties.renderBron ?? null;
  if (!renderBron && opties.renderSecties && /^https?:\/\//.test(sourceUrl)) {
    try {
      renderBron = await haalRenderSecties({
        sourceUrl,
        analyseBron: bronBestand,
        plan: sectiePlan(gesorteerd.map((sh) => ({ start: sh.start - OVERLAP, end: sh.end + OVERLAP }))),
        map: join(werkmap, 'secties'),
        videoDuur: await duurVan(bronBestand),
        videoId: opties.videoId,
        log,
      });
    } catch (e) {
      log(`renderbron niet beschikbaar (${(e as Error).message.slice(0, 120)}); alles uit de analysebron`);
    }
  }
  let shotsUitSectie = 0;
  // Leestijd van graphics: welk deelstuk vastgehouden wordt en welk volgend
  // deelstuk daarvoor aan zijn begin inlevert (leestijd.ts).
  const lees = leestijdPlan(gesorteerd, kader);
  kwaliteit.leestijd = leesLogregel(lees);

  // Per naad (tussen shot i en i+1): de lengte van de audio-crossfade en de
  // J/L-verschuiving. Een weggeknipte pauze (strakke, niet-aansluitende naad)
  // krijgt een korte crossfade (PAUZE_CROSSFADE): lang genoeg tegen een tik of
  // plotse stilte, kort genoeg om de adem niet te versmeren.
  const naadFade = gesorteerd.slice(0, -1).map((shot, i) => {
    const volgend = gesorteerd[i + 1];
    const pauzeKnip = volgend.strakBegin && volgend.start - shot.end > 0.05;
    return pauzeKnip ? instelling('PAUZE_CROSSFADE') : OVERLAP;
  });
  const naadVerschuif = gesorteerd.slice(0, -1).map((shot) => shot.audioNaad ?? 0);

  gesorteerd.forEach((shot, i) => {
    const duur = shot.end - shot.start;
    const handleVoor = i === 0 ? 0 : naadFade[i - 1] / 2;
    const handleNa = i === gesorteerd.length - 1 ? 0 : naadFade[i] / 2;
    const verschuifVoor = i === 0 ? 0 : naadVerschuif[i - 1];
    const verschuifNa = i === gesorteerd.length - 1 ? 0 : naadVerschuif[i];
    // Uit welke bron dit shot komt: de sectie die het hele shot plus handles
    // bevat, anders de analysebron. Beeld én geluid uit hetzelfde bestand, dus
    // ze blijven onderling synchroon.
    const sectie = renderBron ? sectieVoor(renderBron.secties, Math.max(0, shot.start - handleVoor), shot.end + handleNa) : null;
    if (sectie) shotsUitSectie++;
    const invoerBestand = sectie?.pad ?? bronBestand;
    const bronTijd = (t: number) => (sectie ? sectieTijd(sectie, t) : t);
    const beeldTijd = (t: number) => (sectie ? sectieBeeldTijd(sectie, t) : t);
    const bronHoogte = sectie?.hoogte ?? bronInfo?.hoogte ?? 1080;
    // Heeft de kadercontrole een zoom vastgesteld, dan wint die: hij is
    // getoetst tegen het werkelijke gezichtsvak. Anders de zoom die het shot
    // uit zichzelf verdient (spreker klein in beeld → inzoomen tot het hoofd
    // het beeld draagt, begrensd op zijn bewegingsruimte).
    const zoom = shot.zoom ?? basisZoom(shot);
    // Een retentie-kaderwissel als push: renderen op het wijdste van de twee
    // kaders en in RETENTIE_WISSEL_DUUR naar het nieuwe kader zoomen.
    const vorige = i > 0 ? gesorteerd[i - 1] : null;
    const pushVan =
      opties.afwerking?.easing !== false && shot.zachteWissel && vorige && Math.abs(shot.start - vorige.end) <= 0.05
        ? (vorige.zoom ?? basisZoom(vorige))
        : null;
    const zoomRender = pushVan !== null ? Math.min(pushVan, zoom) : zoom;
    // Is de bron hier een split screen, dan eerst het paneel met de spreker
    // uitsnijden; daarna doet de rest van de keten alsof dat het hele beeld is.
    const paneel = shot.paneel;
    const paneelKnip = paneel
      ? `crop=iw*${(paneel[1] - paneel[0]).toFixed(4)}:ih:iw*${paneel[0].toFixed(4)}:0,`
      : '';
    const focusInPaneel =
      paneel && typeof shot.focusX === 'number'
        ? Math.min(1, Math.max(0, (shot.focusX - paneel[0]) / (paneel[1] - paneel[0])))
        : shot.focusX;

    // Volgt de uitsnede de spreker? Het spoor staat in absolute brontijd en
    // wordt hier pas omgerekend naar shot-tijd — zo overleeft het elke latere
    // grensverschuiving.
    const spoorInPaneel = shot.spoor?.map((punt) => ({
      t: punt.t - shot.start,
      x: paneel ? (punt.x - paneel[0]) / (paneel[1] - paneel[0]) : punt.x,
    }));
    const spoorYRel = shot.spoorY?.map((punt) => ({ t: punt.t - shot.start, x: punt.x }));
    // Per deelstuk een eigen kader: knipt de bron binnen dit shot van de
    // spreker naar een graphic, dan wisselt het kader op precies die bronknip
    // (scenes.ts). Zonder scènes is het één deelstuk met het shotkader: het
    // beeldtype van de kadercontrole wint van de clipkeuze, in beide
    // richtingen (graphic → blur, sprekend hoofd in een blur-clip → vullend).
    const delen = deelstukken(shot, kader);
    const staand = delen[0].kader !== 'origineel';
    const easing = opties.afwerking?.easing !== false;
    const effect =
      [
        effectKeten(shot.beeld_effect, duur, { fps: fpsUit, staand, easing }),
        pushVan !== null ? effectKeten('wissel', duur, { fps: fpsUit, staand, easing, van: pushVan / zoomRender, naar: zoom / zoomRender }) : null,
        shot.hit !== undefined ? effectKeten('hit', duur, { fps: fpsUit, staand, easing, vanaf: shot.hit }) : null,
      ]
        .filter(Boolean)
        .join(',') || null;
    const ketenVoor = (deel: (typeof delen)[number]) => {
      // Een graphic wordt passend getoond: het paneel van de spreker ertussen
      // uitsnijden zou de graphic juist weer aansnijden.
      const knip = deel.gezicht === false ? '' : paneelKnip;
      const spoorDeel = spoorInPaneel?.map((punt) => ({ t: punt.t - deel.van, x: punt.x }));
      const spoorYDeel = spoorYRel?.map((punt) => ({ t: punt.t - deel.van, x: punt.x }));
      if (deel.kader === 'vullend' || deel.kader === 'staand') {
        kwaliteit.opschaalMax = Math.max(kwaliteit.opschaalMax, opschaalFactor(zoom, bronHoogte));
      }
      // Een graphic met gemeten inhoud: ingezoomd op die inhoud (graphics.ts).
      const inhoud = deel.kader === 'blur' && deel.inhoud ? inhoudKader(deel.inhoud, verhouding) : undefined;
      if (inhoud) kwaliteit.graphicsIngezoomd++;
      if (deel.kader === 'blur' && deel.gezicht === false) {
        const schaal = deel.inhoud ? schaalTovPassend(deel.inhoud, verhouding) : 1;
        const sleutel = `shot ${shot.volgorde} ${(shot.start + deel.van).toFixed(1)} s`;
        if (!kwaliteit.graphicSchalen.some((x) => x.startsWith(sleutel))) {
          kwaliteit.graphicSchalen.push(`${sleutel} ×${schaal.toFixed(2).replace('.', ',')}${deel.inhoud ? '' : ' (passend)'}`);
        }
      }
      if (deel.gezicht === false || (deel.gezicht === null && deel.kader === 'blur' && shot.beeldtype === 'graphic')) kwaliteit.graphicDelen++;
      else kwaliteit.persoonDelen++;
      return (
        knip +
        kaderKeten(deel.kader, {
          // Een wijd shot zonder gemeten gezicht: de geschatte persoonsplek
          // (uit beweging) als er geen gemeten focus is.
          focusX: focusNaarX(shot.focus, focusInPaneel ?? deel.persoonX ?? undefined),
          focusExpr: spoorDeel ? (spoorExpressie(spoorDeel) ?? undefined) : undefined,
          zoom: zoomRender,
          focusY: shot.focusY,
          focusYExpr: spoorYDeel ? (spoorExpressie(spoorYDeel) ?? undefined) : undefined,
          bronHoogte,
          inhoud,
        }) +
        // Kleurcorrectie alleen op camerabeeld: een graphic heeft de kleuren
        // van het merk, die blijven zoals ze zijn.
        (opties.afwerking?.kleurFilter && (deel.kader === 'vullend' || deel.kader === 'staand') ? `,${opties.afwerking.kleurFilter}` : '')
      );
    };
    // Twee invoeren per shot: beeld precies op de knip, geluid met handles
    // eromheen. Die handles zijn wat een crossfade mogelijk maakt — zonder
    // materiaal vóór en ná het knippunt valt er niets te vervlechten en blijft
    // het een harde overgang met een fade eroverheen.
    //
    // Alleen aan de kanten waar een naad zit: het begin van de clip en het
    // einde blijven exact staan, zodat de totale lengte gelijk blijft aan de
    // som van de shots en beeld en geluid synchroon blijven.
    invoer.push('-ss', beeldTijd(shot.start).toFixed(3), '-t', duur.toFixed(3), '-i', invoerBestand);
    // Het geluid: dezelfde bron, met handles voor de crossfades en de J/L-
    // verschuivingen. Een J-cut laat het geluid van dit shot eerder beginnen
    // (de naad ervóór schuift naar links), een L-cut laat het langer doorlopen.
    // De som van alle geluidsstukken blijft gelijk aan het beeld.
    invoer.push(
      '-ss', bronTijd(Math.max(0, shot.start + verschuifVoor - handleVoor)).toFixed(3),
      '-t', (duur - verschuifVoor + verschuifNa + handleVoor + handleNa).toFixed(3),
      '-i', invoerBestand,
    );
    const aanpassing = delen.map((_, k) => lees.aanpassing.get(`${i}:${k}`) ?? { vasthouden: 0, inkorten: 0 });
    if (delen.length === 1 && aanpassing[0].vasthouden === 0 && aanpassing[0].inkorten === 0) {
      delenVideo.push(
        `[${i * 2}:v]setpts=PTS-STARTPTS,fps=${fpsUit},${ketenVoor(delen[0])}${effect ? `,${effect}` : ''},setsar=1[v${i}]`,
      );
    } else {
      // Eén invoer, gesplitst en per deelstuk getrimd: het geluid blijft één
      // doorlopende invoer, alleen de beeldketen wisselt op de bronknip.
      // Leestijd: een graphic houdt zijn laatste frame vast (tpad), het
      // deelstuk erna begint zoveel later in de bron — zo blijft elk beeld op
      // zijn eigen brontijd en loopt het geluid ongemoeid door.
      const labels = delen.map((_, k) => `v${i}d${k}`);
      // Vasthouden gebeurt met een frame van ín de graphic (deel.bevries, het
      // laatste meetmoment dat echt een graphic was), niet met het laatste
      // frame van het deelstuk: dat lag soms al in de overgang naar de spreker,
      // en dan stond de spreker bevroren in het passende kader.
      const houd = delen.map((deel, k) => {
        const h = aanpassing[k].vasthouden;
        if (h <= 0 || deel.bevries === undefined) return null;
        const rel = deel.bevries - shot.start;
        return rel >= deel.van && rel <= deel.tot ? { rel, h } : null;
      });
      // Eén regel per vastgehouden graphic: welk bronmoment er bevriest en
      // met welke inhoud. Zonder dit is een verkeerd bevroren frame in CI niet
      // terug te voeren op de meting.
      delen.forEach((deel, k) => {
        const v = aanpassing[k].vasthouden;
        if (v <= 0) return;
        const b = deel.inhoud;
        log(
          `hold: shot ${shot.volgorde} deel ${k} bron ${(shot.start + deel.van).toFixed(2)}–${(shot.start + deel.tot).toFixed(2)} s, ` +
            `+${v.toFixed(2)} s, bevries ${deel.bevries?.toFixed(2) ?? '—'}${houd[k] ? '' : ' (terugval: laatste frame)'}, ` +
            `inhoud ${b ? `${b.x0.toFixed(2)}–${b.x1.toFixed(2)} × ${b.y0.toFixed(2)}–${b.y1.toFixed(2)}` : 'geen box'}`,
        );
      });
      const invoerLabels = [...labels.map((l) => `[${l}i]`), ...houd.flatMap((x, k) => (x ? [`[v${i}h${k}i]`] : []))];
      let graaf = `[${i * 2}:v]setpts=PTS-STARTPTS,fps=${fpsUit},split=${invoerLabels.length}${invoerLabels.join('')}`;
      const frameDuur = 1 / (Number(fpsUit) || 25);
      delen.forEach((deel, k) => {
        const { vasthouden, inkorten } = aanpassing[k];
        const van = deel.van + inkorten;
        const h = houd[k];
        const vast = vasthouden > 0 && !h ? `,tpad=stop_mode=clone:stop_duration=${vasthouden.toFixed(3)}` : '';
        graaf +=
          `;[${labels[k]}i]trim=start=${van.toFixed(3)}:end=${deel.tot.toFixed(3)},setpts=PTS-STARTPTS,` +
          `${ketenVoor({ ...deel, van })}${vast},setsar=1[${labels[k]}${h ? 'a' : ''}]`;
        if (h) {
          graaf +=
            // Precies één frame: na het fps-filter ligt er in elk venster van
            // één frameduur exact één frame.
            `;[v${i}h${k}i]trim=start=${h.rel.toFixed(3)}:duration=${frameDuur.toFixed(4)},setpts=PTS-STARTPTS,` +
            `${ketenVoor({ ...deel, van: h.rel })},tpad=stop_mode=clone:stop_duration=${Math.max(0, h.h - frameDuur).toFixed(3)},setsar=1[${labels[k]}b]` +
            `;[${labels[k]}a][${labels[k]}b]concat=n=2:v=1:a=0[${labels[k]}]`;
        }
      });
      graaf += `;${labels.map((l) => `[${l}]`).join('')}concat=n=${delen.length}:v=1:a=0${effect ? `,${effect}` : ''},setsar=1[v${i}]`;
      delenVideo.push(graaf);
    }
    // Per-shot fades zijn niet meer nodig: de crossfade hieronder vervlecht de
    // naden. Alleen een minimale fade aan de buitenranden van de clip blijft,
    // tegen een klik bij het starten en stoppen.

    delenAudio.push(
      `[${i * 2 + 1}:a]asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`,
    );
  });

  if (renderBron) {
    kwaliteit.renderbron = {
      secties: renderBron.secties.map((sc) => ({ resolutie: `${sc.breedte}x${sc.hoogte}`, codec: sc.codec, mb: Math.round(sc.bytes / 1e5) / 10 })),
      mbGedownload: renderBron.mbGedownload,
      geschatVolMb: renderBron.geschatVolMb,
      shotsUitSectie,
      shotsTerugval: gesorteerd.length - shotsUitSectie,
      fouten: renderBron.fouten,
    };
    if (shotsUitSectie < gesorteerd.length) {
      log(`renderbron: ${gesorteerd.length - shotsUitSectie} van ${gesorteerd.length} shots uit de analysebron (geen passende sectie)`);
    }
  }

  // Beeld: harde knip, want dat is wat een montage hoort te doen. Geluid:
  // crossfade, zodat het laatste woord uitklinkt ónder het eerste woord van
  // het volgende shot in plaats van dicht te klappen.
  //
  // De lengte klopt vanzelf. Elk shot behalve het eerste en laatste is aan
  // beide kanten een halve overlap langer; de crossfades consumeren precies
  // die extra lengte weer, dus het geluid duurt exact even lang als het beeld.
  //
  // Beeld en geluid worden als twee losse grafen opgebouwd: de geluidsgraaf
  // draait straks een keer extra, alleen om de luidheid te meten.
  // Scherp begin: het eerste stuk van het eerste shot vervangen door het
  // eerste scherpe frame (bevroren). Uit de al verwerkte keten [v0] gepakt,
  // dus met hetzelfde kader en dezelfde kleur; daarna loopt het beeld door
  // vanaf precies dat frame — geen sprong.
  const bevries = gesorteerd[0]?.bevriesBegin;
  if (bevries && bevries.tot > 0 && bevries.tot < gesorteerd[0].end - gesorteerd[0].start - 0.2) {
    const rel = Math.max(0, bevries.bron - gesorteerd[0].start);
    const frameDuur = 1 / (Number(fpsUit) || 25);
    const laatste = delenVideo[0].lastIndexOf('[v0]');
    if (laatste >= 0) {
      delenVideo[0] =
        `${delenVideo[0].slice(0, laatste)}[v0x]${delenVideo[0].slice(laatste + 4)}` +
        `;[v0x]split=2[v0p][v0q]` +
        `;[v0p]trim=start=${rel.toFixed(3)}:duration=${frameDuur.toFixed(4)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${Math.max(0, bevries.tot - frameDuur).toFixed(3)}[v0f]` +
        `;[v0q]trim=start=${bevries.tot.toFixed(3)},setpts=PTS-STARTPTS[v0r]` +
        `;[v0f][v0r]concat=n=2:v=1:a=0,setsar=1[v0]`;
      log(`scherp begin: eerste ${bevries.tot.toFixed(2)} s bevroren op bron ${bevries.bron.toFixed(2)} s`);
    }
  }
  const beeldKoppel = gesorteerd.map((_, i) => `[v${i}]`).join('');
  let videoFilter = `${delenVideo.join(';')};${beeldKoppel}concat=n=${gesorteerd.length}:v=1:a=0[vuit]`;
  let filter = delenAudio.join(';');

  if (gesorteerd.length === 1) {
    filter += `;[a0]anull[aruw]`;
  } else {
    let vorigLabel = 'a0';
    for (let i = 1; i < gesorteerd.length; i++) {
      const uitLabel = i === gesorteerd.length - 1 ? 'aruw' : `ax${i}`;
      // Driehoekig in- en uitfaden: samen houden die de luidheid over de naad
      // constant, waar een gelijkmatige curve een dipje in het midden geeft.
      filter +=
        `;[${vorigLabel}][a${i}]acrossfade=d=${naadFade[i - 1].toFixed(3)}:c1=tri:c2=tri[${uitLabel}]`;
      vorigLabel = uitLabel;
    }
  }

  // Spraak schoonmaken. Ruisonderdrukking (afftdn) is een grof middel: op
  // schone studio-audio hoor je hem als een blikkerig, onderwaterachtig randje
  // om de stem. Hij gaat daarom alleen aan als er werkelijk iets onder de
  // spraak zit — muziek of ruis in de bron — gemeten aan de ruisvloer tijdens
  // de spraakpauzes. Highpass en luidheid blijven altijd staan: die zijn
  // onhoorbaar goed.
  const ruis = opties.ruisvloerDb ?? null;
  const ruisig = ruis !== null && ruis > -45;
  // Broadcast-keten (afwerking): highpass tegen gerommel, lichte
  // ruisonderdrukking (sterker op een ruisige bron), de-esser tegen scherpe
  // s-klanken, een milde compressor (lage ratio, trage release: geen gepomp)
  // en een kleine presence-lift rond 3,5 kHz voor verstaanbaarheid op een
  // telefoonspeaker. De luidheid zelf regelt loudnorm verderop.
  filter += opties.afwerking?.stem
    ? `;[aruw]${stemKeten(ruisig)}[aspraak]`
    : ruisig
      ? `;[aruw]highpass=f=75,afftdn=nf=-22,speechnorm=e=6.25:r=0.00001:l=1[aspraak]`
      : `;[aruw]highpass=f=75,speechnorm=e=5:r=0.00001:l=1[aspraak]`;
  let audioUit = 'aspraak';

  // Tijdvensters op de uiteindelijke tijdlijn waarin de muziek volledig stil
  // moet zijn: payoff-shots en shots met sfx 'stilte'. Dit is het
  // muziek-valt-weg-moment dat de onthulling groot maakt.
  const stilteVensters: { van: number; tot: number }[] = [];
  // De emotiecurve (bouwsteen D): het bed staat niet overal even hard. Een
  // shot zonder "spanning" (oudere plannen) krijgt gewoon de oude vaste 0,34
  // — dat is exact het gedrag van vóór dit veld bestond. Is spanning gezet,
  // dan zakt het bed dieper weg naarmate de spanning oploopt (0,40 bij rustig
  // tot 0,22 vlak voor de payoff): het is stiller om de stem juist ván het
  // moment te laten voelen, niet om het bed harder te laten zwellen — een
  // opzwellend bed onder pratende mensen klinkt al snel als een fout.
  const duckVensters: { van: number; tot: number; vol: number }[] = [];
  {
    let cursor = 0;
    for (const shot of gesorteerd) {
      const duur = shot.end - shot.start;
      if (shot.functie === 'payoff' || shot.sfx === 'stilte') {
        stilteVensters.push({ van: Math.max(0, cursor - 0.4), tot: cursor + duur });
      }
      if (shot.spanning !== undefined) {
        const spanning = Math.min(10, Math.max(1, shot.spanning));
        const vol = instelling('MUZIEK_RUSTIG') - ((spanning - 1) / 9) * instelling('MUZIEK_SPANNING_BEREIK');
        duckVensters.push({ van: cursor, tot: cursor + duur, vol: Math.round(vol * 100) / 100 });
      }
      cursor += duur;
    }
  }

  const extraInvoer: string[] = [];
  // Twee invoeren per shot (beeld en geluid), dus de extra invoeren — muziek,
  // sfx, tekstkaarten — beginnen op het dubbele.
  let extraIndex = gesorteerd.length * 2;

  if (opties.muziekPad && existsSync(opties.muziekPad)) {
    // Het bed net zo vaak herhalen als nodig en dan hard afkappen. Met
    // `-stream_loop -1` is de invoer oneindig; die liep in combinatie met de
    // sidechain-ducking niet meer af en de render hing.
    const bedDuur = await duurVan(opties.muziekPad);
    const rondes = bedDuur > 0 ? Math.max(0, Math.ceil(totaleDuur / bedDuur)) : 0;
    extraInvoer.push('-stream_loop', String(rondes), '-i', opties.muziekPad);

    // De stilte op de payoff niet als harde stap maar als korte ramp: per
    // venster een factor die vóór `van` in een kwart seconde naar 0 zakt en
    // na `tot` in een derde seconde terugkomt. Een stap van 0,34 naar 0 per
    // frame klonk als een klik in plaats van als "de muziek valt weg".
    const rampUit = instelling('MUZIEK_RAMP_UIT').toFixed(2);
    const rampIn = instelling('MUZIEK_RAMP_IN').toFixed(2);
    const stilExpr = stilteVensters.length
      ? stilteVensters
          .map(
            (v) =>
              `min(1,max(0,max((${v.van.toFixed(2)}-t)/${rampUit},(t-${v.tot.toFixed(2)})/${rampIn})))`,
          )
          .join('*')
      : '1';

    // Basisniveau van het bed: 0,34 zonder emotiecurve (het oude gedrag,
    // ongewijzigd), of per shot opgebouwd uit duckVensters als die er zijn.
    // Geneste if()'s, van laatste naar eerste shot, met 0,34 als bodem voor
    // elk shot dat geen spanning meekreeg.
    const basisVolExprRuw = duckVensters.reduceRight(
      (acc, v) => `if(between(t\\,${v.van.toFixed(2)}\\,${v.tot.toFixed(2)})\\,${v.vol}\\,${acc})`,
      String(instelling('MUZIEK_BASIS')),
    );
    // Na de hook mag het bed iets aanzetten (energie), in een halve seconde
    // omhoog in plaats van een stap.
    const naHook = opties.afwerking?.muziekNaHook;
    const basisVolExpr =
      naHook !== undefined
        ? `(${basisVolExprRuw})*(1+${(instelling('MUZIEK_NA_HOOK') - 1).toFixed(3)}*min(1\\,max(0\\,(t-${naHook.toFixed(2)})/0.5)))`
        : basisVolExprRuw;

    // Ducking in twee lagen. De sidechain volgt de spraak op de voet (snel
    // dicht, traag open, zodat hij niet tussen twee woorden omhoog pompt), en
    // daar bovenop staat de harde nul op de payoff: dát is het moment dat
    // groot moet worden, en een compressor alleen krijgt hem nooit ver genoeg
    // omlaag.
    filter +=
      `;[${extraIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
      `atrim=0:${(totaleDuur + 0.5).toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=1.2,afade=t=out:st=${Math.max(0, totaleDuur - 1.2).toFixed(3)}:d=1.2,` +
      `volume='(${basisVolExpr})*(${stilExpr})':eval=frame[muz]` +
      // De spraak wordt hier twee keer gebruikt: als stuursignaal voor de
      // ducking én in de uiteindelijke mix. Eén filterlabel kan maar door één
      // filter opgegeten worden, dus eerst splitsen. Zonder die split loopt de
      // filtergraph vast — daarom kwam er tot nu toe nooit muziek uit een
      // render met een bed.
      `;[${audioUit}]asplit=2[sprk][stuur]` +
      // Milde ducking: het bed zakt onder de spraak maar verdwijnt niet. Met
      // ratio 12 werd er in een clip waarin bijna onafgebroken gepraat wordt
      // helemaal niets meer van gehoord — dan kun je het net zo goed weglaten.
      `;[muz][stuur]sidechaincompress=` +
      `threshold=0.06:ratio=4:attack=15:release=450:makeup=1:level_sc=1[muzged]` +
      `;[sprk][muzged]amix=inputs=2:duration=first:normalize=0[amix]`;
    audioUit = 'amix';
    extraIndex += 1;
  }

  // Geluidseffecten. Met een sfx-plan (sounddesign.ts) op precies de geplande
  // momenten en volumes; anders zoals voorheen: per shot op zijn begin.
  if (opties.sfxMap && opties.afwerking?.sfxPlan) {
    for (const p of opties.afwerking.sfxPlan) {
      const bestand = [join(opties.sfxMap, `${p.slug}.wav`), join(opties.sfxMap, `${p.slug}.mp3`)].find((k) => existsSync(k));
      if (!bestand || p.t < 0 || p.t >= totaleDuur) continue;
      extraInvoer.push('-i', bestand);
      const ms = Math.round(p.t * 1000);
      filter +=
        `;[${extraIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
        `volume=${(p.volume ?? instelling('SFX_VOLUME')).toFixed(3)},adelay=${ms}|${ms}[fx${extraIndex}]` +
        `;[${audioUit}][fx${extraIndex}]amix=inputs=2:duration=first:normalize=0[am${extraIndex}]`;
      audioUit = `am${extraIndex}`;
      extraIndex += 1;
    }
  } else if (opties.sfxMap) {
    let cursor = 0;
    for (const shot of gesorteerd) {
      const duur = shot.end - shot.start;
      const slug = shot.sfx;
      if (slug && slug !== 'geen' && slug !== 'stilte') {
        const kandidaten = [join(opties.sfxMap, `${slug}.wav`), join(opties.sfxMap, `${slug}.mp3`)];
        const bestand = kandidaten.find((k) => existsSync(k));
        if (bestand) {
          extraInvoer.push('-i', bestand);
          filter +=
            `;[${extraIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
            // 0,18 boven een bestand dat al op -14 dBFS staat. Gesynthetiseerde
            // effecten hebben een plafond in klankkwaliteit; het minste wat we
            // kunnen doen is ze niet naar de voorgrond duwen. Eigen bestanden
            // met dezelfde slug in assets/sfx winnen hiervan.
            `volume=0.18,adelay=${Math.round(cursor * 1000)}|${Math.round(cursor * 1000)}[fx${extraIndex}]` +
            `;[${audioUit}][fx${extraIndex}]amix=inputs=2:duration=first:normalize=0[am${extraIndex}]`;
          audioUit = `am${extraIndex}`;
          extraIndex += 1;
        }
      }
      cursor += duur;
    }
  }

  invoer.push(...extraInvoer);

  // Tot slot de hele mix op één luidheid zetten. Social-platforms mikken rond
  // -14 LUFS; zit je daaronder dan klinkt je clip zwak naast de rest van de
  // feed, zit je erboven dan draaien ze hem zelf terug. De limiter houdt de
  // ware piek onder -1,5 dBFS zodat de omzetting naar AAC bij het platform
  // niet alsnog gaat klippen.
  //
  // In twee passes. Zonder gemeten waarden draait loudnorm in zijn
  // "dynamische" stand en dat pompt hoorbaar op spraak — bovenop speechnorm
  // en de ducking. Eerst meten (alleen de geluidsgraaf, geen beeld), dan met
  // de meting in lineaire stand: één vaste versterking, geen gepomp.
  const LOUDNORM = 'I=-14:TP=-1.5:LRA=9';
  const meting = await meetLoudnorm(invoer, `${filter};[${audioUit}]loudnorm=${LOUDNORM}:print_format=json[ameet]`, log);
  filter += meting
    ? `;[${audioUit}]loudnorm=${LOUDNORM}:measured_I=${meting.input_i}:measured_LRA=${meting.input_lra}:measured_TP=${meting.input_tp}:measured_thresh=${meting.input_thresh}:offset=${meting.target_offset}:linear=true,alimiter=limit=0.86:level=disabled[aklaar]`
    : `;[${audioUit}]loudnorm=${LOUDNORM},alimiter=limit=0.86:level=disabled[aklaar]`;
  audioUit = 'aklaar';

  // Ondertitels: ingebrand vóór de kaarten, zodat een kaart erbovenop ligt.
  let laatsteV = 'vuit';
  if (opties.ondertitelAss && existsSync(opties.ondertitelAss)) {
    videoFilter += `;[vuit]${assFilter(opties.ondertitelAss)}[vsub]`;
    laatsteV = 'vsub';
  }

  // Tekstkaarten en hook in het beeld branden: elke PNG als extra invoer, met
  // een tijdvenster waarin hij zichtbaar is.
  const overlays = opties.overlays ?? [];
  overlays.forEach((o, n) => {
    const inputIndex = extraIndex + n;
    invoer.push('-i', o.pad);
    const uitLabel = n === overlays.length - 1 ? 'vfinal' : `vo${n}`;
    videoFilter += `;[${laatsteV}][${inputIndex}:v]overlay=0:0:enable='between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})'[${uitLabel}]`;
    laatsteV = uitLabel;
  });

  await run(resolveBinary('ffmpeg'), [
    '-y',
    ...invoer,
    '-filter_complex', `${videoFilter};${filter}`,
    '-map', `[${laatsteV}]`, '-map', `[${audioUit}]`,
    ...encode,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    outputPad,
  ]);

  // Past het bestand niet binnen de opslaglimiet, dan comprimeren we het naar
  // een bitrate die wél past. Liever iets minder scherp dan helemaal geen
  // montage: dit is werkmateriaal voor de editor, geen eindproduct.
  if (opties.maxBytes && !opties.tussenbestand) {
    const { size } = await stat(outputPad);
    if (size > opties.maxBytes) {
      log(`${Math.round(size / 1e6)}MB is te groot; opnieuw comprimeren…`);
      const kleiner = join(werkmap, 'passend.mp4');
      // 8 bits per byte, en wat ruimte laten voor audio en container.
      const bitrate = Math.floor(((opties.maxBytes * 8) / Math.max(totaal, 1)) * 0.9);

      await run(resolveBinary('ffmpeg'), [
        '-y', '-i', outputPad,
        '-c:v', 'libx264', '-preset', 'medium',
        '-b:v', `${Math.max(bitrate - 128_000, 400_000)}`,
        '-maxrate', `${Math.max(bitrate - 128_000, 400_000)}`,
        '-bufsize', `${Math.max(bitrate, 800_000) * 2}`,
        '-c:a', 'aac', '-b:a', '128k',
        kleiner,
      ]);

      await rm(outputPad, { force: true });
      await rename(kleiner, outputPad);
      log(`nu ${Math.round((await stat(outputPad)).size / 1e6)}MB`);
    }
  }

  // Geen tussenbestanden meer op te ruimen: de montage wordt in één doorloop
  // gebouwd. De bronvideo blijft staan voor de volgende clip.
  return { pad: outputPad, duur: Math.round(totaal), bron: bronInfo, kwaliteit };
}

/** Een geluidseffect op een moment van de tijdlijn (sounddesign.ts). */
export type SfxPlek = { slug: string; t: number; volume?: number; reden?: string };

export type RenderAfwerking = {
  /** Zachte in- en uitloop op zooms (en retentiewissels als push). */
  easing?: boolean;
  /** ffmpeg-filter voor de kleurcorrectie op sprekende beelden (kleur.ts), of null. */
  kleurFilter?: string | null;
  /** Broadcast-stemketen in plaats van alleen highpass + speechnorm. */
  stem?: boolean;
  /** Geplaatste geluidseffecten; vervangt de sfx per shot. */
  sfxPlan?: SfxPlek[];
  /** Vanaf deze tijdlijnseconde (einde hook) mag het muziekbed iets harder (MUZIEK_NA_HOOK). */
  muziekNaHook?: number;
};

/** Wat de kwaliteitsregel in de log nodig heeft: opschaling en de verdeling persoon/graphic. */
export type RenderKwaliteit = {
  opschaalMax: number;
  persoonDelen: number;
  graphicDelen: number;
  /** Graphic-deelstukken die op hun gemeten inhoud zijn ingezoomd. */
  graphicsIngezoomd: number;
  /** Per graphic de schaal van de inhoud t.o.v. het passende kader (1 = passend). */
  graphicSchalen: string[];
  /** De leestijd-logregel (leestijd.ts). */
  leestijd?: string;
  renderbron: {
    secties: { resolutie: string; codec: string; mb: number }[];
    mbGedownload: number;
    geschatVolMb: number | null;
    shotsUitSectie: number;
    shotsTerugval: number;
    fouten: string[];
  } | null;
};

/**
 * De videoencode van elk bestand dat de deur uitgaat (montage én elke
 * hookvariant): één plek, zodat de drie varianten nooit verschillend
 * gecomprimeerd worden. Het maxBytes-plafond van de opslag wint van
 * ENCODE_MAXRATE als het lager uitkomt.
 */
export function encodeArgs(opties: { maxBytes?: number; duur?: number; tussen?: boolean } = {}): string[] {
  if (opties.tussen) {
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(instelling('ENCODE_CRF_TUSSEN')), '-pix_fmt', 'yuv420p'];
  }
  const opslagPlafond =
    opties.maxBytes && opties.duur && opties.duur > 0
      ? Math.max(800_000, Math.floor(((opties.maxBytes * 8) / opties.duur) * 0.85) - 192_000)
      : Infinity;
  const maxrate = Math.min(instelling('ENCODE_MAXRATE'), opslagPlafond);
  const bufsize = Math.min(instelling('ENCODE_BUFSIZE'), maxrate * 2);
  return [
    '-c:v', 'libx264', '-preset', encodePreset(), '-crf', String(instelling('ENCODE_CRF')),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-maxrate', String(Math.round(maxrate)), '-bufsize', String(Math.round(bufsize)),
  ];
}

/**
 * Downloadt de bronvideo als hij er nog niet staat, in een formaat dat zowel
 * ffmpeg als Premiere aankan (H.264 + AAC). Uitgesplitst zodat de worker de
 * bron vóór de eerste clip kan klaarzetten voor stilte- en gezichtsmeting.
 */
export async function zorgVoorBron(
  sourceUrl: string,
  werkmap: string,
  log: (m: string) => void = () => {},
  opties: { videoId?: string } = {},
): Promise<string> {
  await mkdir(werkmap, { recursive: true });
  const bronBestand = join(werkmap, 'bron.mp4');

  // Eerst de R2-cache (broncache.ts): een tweede render van dezelfde video
  // hoeft niet opnieuw van YouTube te downloaden.
  if (!existsSync(bronBestand) && opties.videoId) {
    if (await haalUitBronCache(bronSleutel(opties.videoId, 'analyse.mp4'), bronBestand)) {
      log('Bronvideo uit de R2-cache.');
      return bronBestand;
    }
  }

  if (!existsSync(bronBestand)) {
    log('Bronvideo downloaden…');
    // De analysebron: de hele video, alleen om te meten (gezichten, scènes,
    // woordtijden, stiltes — allemaal genormaliseerd of in brontijd). 1080p
    // H.264 is ruim genoeg en leest overal, ook in OpenCV. De scherpte voor
    // het eindbeeld komt uit de renderbron (renderbron.ts): alleen de
    // gebruikte stukken, in de hoogste kwaliteit.
    const max = instelling('BRON_MAX_HOOGTE');
    await voerYtdlpUit([
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=default,tv',
      '-f',
      `bv*[vcodec^=avc1][height<=${max}]+ba[ext=m4a]/b[vcodec^=avc1][height<=${max}]/bv*[height<=${max}]+ba[ext=m4a]/b[height<=${max}]/b`,
      '--merge-output-format', 'mp4',
      '-o', bronBestand,
      sourceUrl,
    ], { log });
    if (opties.videoId && (await bewaarInBronCache(bronSleutel(opties.videoId, 'analyse.mp4'), bronBestand))) {
      log('Bronvideo in de R2-cache gezet.');
    }
  } else {
    log('Bronvideo staat al klaar.');
  }
  return bronBestand;
}

/**
 * De definitieve segmentlijst van een montage: geknipt op spraakpauzes en met
 * de dode lucht eruit. Zelfde volgorde en velden als het plan, dus de
 * aanroeper kan hier kaartposities en ondertitels op uitrekenen.
 */
export function bepaalSegmenten(
  shots: Shot[],
  opties: {
    transcript?: SnapSegment[];
    stiltes?: Stilte[];
    uitgelijnd?: boolean;
    woordgrenzen?: number[];
  },
): (Shot & { subKnip?: boolean })[] {
  // Na citaat-uitlijning zitten de grenzen al op het woord; dan mag de
  // stilte-snap alleen nog micro-corrigeren, niet naar een andere zin springen.
  const gesnapt = snapShots(shots, opties.transcript ?? [], {
    stiltes: opties.stiltes,
    venster: opties.uitgelijnd ? 0.35 : undefined,
    alleenVerruimen: opties.uitgelijnd,
    woordgrenzen: opties.woordgrenzen,
  });
  const zonderDodeLucht = verwijderDodeLucht(gesnapt, opties.stiltes ?? []);
  return [...zonderDodeLucht].sort((a, b) => (a.volgorde ?? 0) - (b.volgorde ?? 0)).filter((s) => s.end > s.start);
}

/** Ruimt gedownloade bronvideo's op; die zijn groot en makkelijk opnieuw op te halen. */
export async function ruimBronnenOp(werkmap: string): Promise<number> {
  if (!existsSync(werkmap)) return 0;
  let opgeruimd = 0;
  for (const item of await readdir(werkmap, { withFileTypes: true })) {
    if (item.isDirectory()) {
      await rm(join(werkmap, item.name), { recursive: true, force: true });
      opgeruimd++;
    }
  }
  return opgeruimd;
}


function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', () =>
      reject(new Error(`${command} niet gevonden. Installeer met: brew install yt-dlp ffmpeg`)),
    );
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exit ${code}: ${stderr.trim().slice(-400)}`)),
    );
  });
}

/**
 * Zoekt de spraakpauzes in een bestand. Dit is het betrouwbaarste signaal voor
 * schone knippen: het transcript is te grof (rollende ondertitelblokken van
 * seconden), maar de audio liegt niet. Eén meting per video volstaat; het
 * resultaat gaat de database in en wordt door zowel de montage als het
 * Premiere-project gebruikt.
 */
export async function detecteerStiltes(
  pad: string,
  opties: { drempelDb?: number; minDuur?: number } = {},
): Promise<{ start: number; end: number }[]> {
  const drempel = opties.drempelDb ?? -32;
  const minDuur = opties.minDuur ?? 0.1;

  // ffmpeg schrijft de meetresultaten naar stderr, niet naar stdout — vandaar
  // een eigen spawn die beide stromen meeneemt in plaats van run().
  const uit = await new Promise<string>((klaar) => {
    const kind = spawn(resolveBinary('ffmpeg'), [
      '-i', pad,
      '-af', `silencedetect=noise=${drempel}dB:d=${minDuur}`,
      '-f', 'null', '-',
    ]);
    let alles = '';
    kind.stdout.on('data', (d) => (alles += d));
    kind.stderr.on('data', (d) => (alles += d));
    kind.on('error', () => klaar(''));
    kind.on('close', () => klaar(alles));
  });

  const stiltes: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const regel of uit.split('\n')) {
    const start = regel.match(/silence_start:\s*([\d.]+)/);
    if (start) open = Number(start[1]);
    const eind = regel.match(/silence_end:\s*([\d.]+)/);
    if (eind && open !== null) {
      stiltes.push({ start: open, end: Number(eind[1]) });
      open = null;
    }
  }
  return stiltes;
}

/**
 * Meet hoe luid het is tijdens de spraakpauzes: de ruisvloer van de bron.
 *
 * Zit er muziek of ruis onder het gesprek, dan is het tussen de zinnen niet
 * stil maar bijvoorbeeld -30 dB. Bij schone studio-audio zakt het naar -60 dB
 * of lager. Dat verschil bepaalt of ruisonderdrukking nodig is — en die zetten
 * we liever uit, want op schone spraak hoor je hem als een blikkerig randje.
 *
 * We meten een handvol pauzes in plaats van allemaal: dat is genoeg voor een
 * betrouwbaar beeld en kost een fractie van de tijd.
 */
export async function meetRuisvloer(
  pad: string,
  stiltes: { start: number; end: number }[],
): Promise<number | null> {
  const bruikbaar = stiltes.filter((s) => s.end - s.start > 0.5).slice(0, 40);
  if (bruikbaar.length === 0) return null;

  // Verspreid over de video, zodat één stil begin niet het hele oordeel bepaalt.
  const stap = Math.max(1, Math.floor(bruikbaar.length / 6));
  const monsters = bruikbaar.filter((_, i) => i % stap === 0).slice(0, 6);

  const metingen: number[] = [];
  for (const s of monsters) {
    const uit = await new Promise<string>((klaar) => {
      const kind = spawn(resolveBinary('ffmpeg'), [
        '-nostdin',
        '-ss', (s.start + 0.15).toFixed(3),
        '-t', Math.min(0.6, s.end - s.start - 0.25).toFixed(3),
        '-i', pad,
        '-af', 'volumedetect',
        '-f', 'null', '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let alles = '';
      kind.stdout.on('data', (d) => (alles += d));
      kind.stderr.on('data', (d) => (alles += d));
      kind.on('error', () => klaar(''));
      kind.on('close', () => klaar(alles));
    });
    const m = uit.match(/mean_volume:\s*(-?[\d.]+) dB/);
    if (m) metingen.push(Number(m[1]));
  }

  if (metingen.length === 0) return null;
  // Mediaan: één pauze waarin iemand toevallig hoest telt niet mee.
  const gesorteerd = [...metingen].sort((a, b) => a - b);
  return Math.round(gesorteerd[Math.floor(gesorteerd.length / 2)] * 10) / 10;
}

/**
 * Hoeveel er ingezoomd moet worden om de spreker het beeld te laten dragen.
 *
 * De uitsnede van 16:9 naar 9:16 pakt ongeveer een derde van de breedte. Staat
 * een hoofd op 8% van het beeld, dan wordt dat in de uitsnede zo'n 24% — dat
 * leest nog als een totaalshot.
 *
 * We mikken op bijna de halve uitsnedebreedte. Een derde bleek te bescheiden:
 * op de telefoon bleef er dan een gesprekspartner en een halve boekenkast
 * omheen staan en droeg het hoofd het beeld niet. Boven 1,7 stoppen we, want
 * verder inzoomen kost zichtbaar scherpte.
 */
function vulZoom(focusW?: number): number {
  if (!focusW || focusW <= 0) return 1;
  const inUitsnede = focusW * 3; // 1080 van 1920 breed is grofweg een derde
  const gewenst = instelling('ZOOM_GEWENST_HOOFDBREEDTE');
  return Math.min(instelling('ZOOM_MAX'), Math.max(1, gewenst / inUitsnede));
}

/**
 * De framerate waarin gerenderd wordt: die van de bron, als die er is en
 * plausibel is. Een breuk als 30000/1001 gaat als decimaal door, dat kent het
 * fps-filter.
 */
export function fpsVoorRender(bron: BronEigenschappen | null): string {
  const fps = bron?.fps;
  if (!fps || !Number.isFinite(fps) || fps < 23 || fps > 61) return '30';
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3);
}

/**
 * Jump-cuts afdekken (editcraft): een knip binnen dezelfde opname is
 * zichtbaar als een hapering. Dat geldt voor de dode-luchtknippen én voor elk
 * paar opeenvolgende shots dat in de bron vrijwel aansluit (zelfde camera,
 * zelfde houding). Een schaalverschil van ruim 10% maakt er een bewuste
 * punch-in van; zonder dat verschil leest de naad als "niet smooth".
 *
 * Schrijft de bump in `shot.zoom`, zodat de kadercontrole en de keuring
 * dezelfde zoom zien als de render. Gevolgde shots slaan we over — daar
 * beweegt het kader al. Aan te roepen vóór corrigeerKadrering.
 */
export function pasNaadZoomToe(segmenten: Shot[]): { volgorde: number; zoom: number }[] {
  const bump = instelling('ZOOM_NAADBUMP');
  const minVerschil = instelling('ZOOM_NAAD_MIN_VERSCHIL');
  const max = instelling('ZOOM_MAX');
  const gedaan: { volgorde: number; zoom: number }[] = [];
  let vorigeZoom = 1;
  const gesorteerd = [...segmenten].sort((a, b) => a.volgorde - b.volgorde);
  gesorteerd.forEach((shot, i) => {
    let zoom = shot.zoom ?? basisZoom(shot);
    const vorige = i > 0 ? gesorteerd[i - 1] : null;
    const doorloop =
      shot.subKnip || (vorige !== null && shot.start - vorige.end > -0.1 && shot.start - vorige.end < 2.5);
    if (doorloop && !shot.spoor?.length && Math.abs(zoom - vorigeZoom) < minVerschil) {
      // Altijd eerst omhóóg: een naadknip hoort een punch-in te zijn. Omlaag
      // gaf precies de klacht "de zoom gebeurt niet" — het vervolgshot werd
      // wijder en de tweeshot kwam terug in beeld.
      zoom = vorigeZoom + bump <= max ? vorigeZoom + bump : Math.max(1, vorigeZoom - bump);
      shot.zoom = Math.round(zoom * 1000) / 1000;
      gedaan.push({ volgorde: shot.volgorde, zoom: shot.zoom });
    }
    vorigeZoom = zoom;
  });
  return gedaan;
}

type LoudnormMeting = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

/**
 * Eerste pass van loudnorm: dezelfde geluidsgraaf draaien zonder beeld en de
 * meting uit de JSON op stderr lezen. Mislukt dit, dan valt de render terug
 * op de dynamische stand — liever gepomp dan geen clip.
 */
async function meetLoudnorm(
  invoer: string[],
  audioFilter: string,
  log: (m: string) => void,
): Promise<LoudnormMeting | null> {
  try {
    const uit = await runMetStderr(resolveBinary('ffmpeg'), [
      '-nostdin', '-y', ...invoer,
      '-filter_complex', audioFilter,
      '-map', '[ameet]', '-vn', '-f', 'null', '-',
    ]);
    const json = uit.match(/\{[^{}]*"input_i"[^{}]*\}/);
    if (!json) return null;
    const m = JSON.parse(json[0]) as Partial<LoudnormMeting>;
    const velden = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const;
    if (velden.some((v) => m[v] === undefined || !Number.isFinite(Number(m[v])))) return null;
    // loudnorm geeft -inf op stilte; daar kan de lineaire stand niets mee.
    return m as LoudnormMeting;
  } catch (e) {
    log(`luidheidsmeting mislukt (${(e as Error).message.slice(0, 80)}); loudnorm in dynamische stand`);
    return null;
  }
}

/**
 * Een overlay (hookkaart) over een al gerenderde montage branden. Voor de
 * hookvarianten: dezelfde montage, drie keer een andere kaart, zonder de
 * filterketen of een Claude-call opnieuw te draaien. Geluid wordt gekopieerd.
 */
export async function brandOverlays(
  bronPad: string,
  overlays: BurnOverlay[],
  uitPad: string,
  opties: { maxBytes?: number; duur?: number } = {},
): Promise<void> {
  if (overlays.length === 0) throw new Error('Geen overlays om te branden.');
  const invoer = ['-i', bronPad];
  let filter = '';
  let laatste = '0:v';
  overlays.forEach((o, n) => {
    invoer.push('-i', o.pad);
    const uit = n === overlays.length - 1 ? 'vfinal' : `vo${n}`;
    filter += `${filter ? ';' : ''}[${laatste}][${n + 1}:v]overlay=0:0:enable='between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})'[${uit}]`;
    laatste = uit;
  });
  // Precies dezelfde encode als een montage zonder hook: alle drie de
  // varianten zijn een eindbestand en horen gelijk te zijn.
  await run(resolveBinary('ffmpeg'), [
    '-y', ...invoer,
    '-filter_complex', filter,
    '-map', `[${laatste}]`, '-map', '0:a?',
    ...encodeArgs({ maxBytes: opties.maxBytes, duur: opties.duur }),
    '-c:a', 'copy',
    '-movflags', '+faststart',
    uitPad,
  ]);
}

/**
 * Alle hookvarianten van één montage, zonder de hele clip per variant
 * opnieuw te encoderen.
 *
 * Voorheen: drie keer de volledige clip opnieuw encoderen (medium, crf 17),
 * alleen om er een andere kaart over de eerste seconden te leggen — bijna
 * twee minuten per clip. Nu: de staart (vanaf het eerste frame ná de langste
 * hookkaart) één keer encoderen, per variant alleen de kop (0 → dat frame)
 * met zijn eigen kaart, en die twee met stream-copy aan elkaar zetten. De
 * staart begint per definitie op een keyframe, de naad valt precies op een
 * framegrens, en het geluid komt ongewijzigd uit de basis (stream-copy): geen
 * tweede AAC-encode, dus geen klik of gat op de naad.
 *
 * Valt de kop bijna samen met het einde (heel korte clip), dan terug naar de
 * oude manier per variant.
 */
export async function brandHookVarianten(
  basisPad: string,
  varianten: { hookPad: string; eind: number; uitPad: string }[],
  opties: {
    maxBytes?: number;
    duur: number;
    werkmap: string;
    /** Alleen voor de test: de staart met afwijkende encode-argumenten, om het veiligheidsnet te toetsen. */
    staartEncode?: string[];
  },
): Promise<{ kopTot: number; manier: 'concat' | 'volledig'; teruggevallen: { uitPad: string; reden: string }[] }> {
  const bron = await probeBron(basisPad).catch(() => null);
  const fps = bron?.fps && bron.fps > 1 ? bron.fps : 25;
  const langste = Math.max(...varianten.map((v) => v.eind));
  // Het eerste frame ná de langste hookkaart (+ één frame speling).
  const frames = Math.ceil((langste + 1 / fps) * fps);
  const kopTot = frames / fps;
  // Kop en staart met exact dezelfde argumenten (maxrate en bufsize hangen
  // van de clipduur af, niet van de lengte van het stuk), plus SPS/PPS bij
  // elk keyframe in de stroom: mocht x264 toch andere headers kiezen, dan
  // draagt de staart zijn eigen headers mee in plaats van te leunen op die
  // van de kop.
  const encode = [...encodeArgs({ maxBytes: opties.maxBytes, duur: opties.duur }), '-x264-params', 'repeat-headers=1'];
  if (kopTot >= opties.duur - 0.5) {
    for (const v of varianten) await brandOverlays(basisPad, [{ pad: v.hookPad, start: 0, end: v.eind }], v.uitPad, { maxBytes: opties.maxBytes, duur: opties.duur });
    return { kopTot, manier: 'volledig', teruggevallen: [] };
  }
  const basisFrames = await telFrames(basisPad);
  const teruggevallen: { uitPad: string; reden: string }[] = [];
  const staart = join(opties.werkmap, `staart-${Date.now()}.mp4`);
  // De staart: frame-exact vanaf kopTot (invoer-seek met decode), alleen beeld.
  await run(resolveBinary('ffmpeg'), [
    '-y', '-ss', kopTot.toFixed(6), '-i', basisPad, '-map', '0:v', '-an', ...(opties.staartEncode ?? encode), '-movflags', '+faststart', staart,
  ]);
  try {
    for (const v of varianten) {
      const kop = join(opties.werkmap, `kop-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
      const lijst = `${kop}.txt`;
      await run(resolveBinary('ffmpeg'), [
        '-y', '-i', basisPad, '-i', v.hookPad,
        '-filter_complex', `[0:v]trim=end_frame=${frames},setpts=PTS-STARTPTS[b];[b][1:v]overlay=0:0:enable='between(t,0,${v.eind.toFixed(2)})'[v]`,
        '-map', '[v]', '-an', ...encode, kop,
      ]);
      // Twee losse encodes mogen alleen met stream-copy aan elkaar als hun
      // SPS/PPS (avcC) identiek zijn: de container heeft er maar één. ffmpeg
      // zelf decodeert een mismatch vaak nog (het leest de nieuwe headers uit
      // de stroom), maar andere spelers en platform-transcoders niet — dus
      // die vergelijking gaat vóór de decode-controle.
      const [exKop, exStaart] = await Promise.all([extradataVan(kop), extradataVan(staart)]);
      if (!exKop || exKop !== exStaart) {
        await rm(kop, { force: true });
        teruggevallen.push({ uitPad: v.uitPad, reden: exKop ? 'SPS/PPS van kop en staart verschillen' : 'headers van de kop niet te lezen' });
        await brandOverlays(basisPad, [{ pad: v.hookPad, start: 0, end: v.eind }], v.uitPad, { maxBytes: opties.maxBytes, duur: opties.duur });
        continue;
      }
      const { writeFile } = await import('node:fs/promises');
      await writeFile(lijst, `file '${kop.replace(/'/g, "'\\''")}'\nfile '${staart.replace(/'/g, "'\\''")}'\n`);
      try {
        await run(resolveBinary('ffmpeg'), [
          '-y', '-f', 'concat', '-safe', '0', '-i', lijst, '-i', basisPad,
          '-map', '0:v', '-map', '1:a?', '-c', 'copy', '-movflags', '+faststart', v.uitPad,
        ]);
      } finally {
        await rm(kop, { force: true });
        await rm(lijst, { force: true });
      }
      // Veiligheidsnet: stream-copy van twee losse encodes onder één header
      // is alleen goed als die headers gelijk zijn. Het hele bestand wordt
      // gedecodeerd; één fout of een ander frameaantal dan de basis → deze
      // variant alsnog volledig opnieuw (brandOverlays). Liever een minuut
      // extra dan een clip die halverwege niet meer afspeelt.
      const controle = await controleerDecode(v.uitPad, basisFrames);
      if (!controle.goed) {
        teruggevallen.push({ uitPad: v.uitPad, reden: controle.reden });
        await brandOverlays(basisPad, [{ pad: v.hookPad, start: 0, end: v.eind }], v.uitPad, { maxBytes: opties.maxBytes, duur: opties.duur });
      }
    }
  } finally {
    await rm(staart, { force: true });
  }
  return { kopTot, manier: 'concat', teruggevallen };
}

/** De codec-headers (avcC: SPS/PPS) van het beeldspoor, als hex; null als onleesbaar. */
export async function extradataVan(pad: string): Promise<string | null> {
  try {
    const uit = await run(resolveBinary('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_data', '-show_entries', 'stream=extradata', pad]);
    const hex = [...uit.matchAll(/^[0-9a-f]{8}: ((?:[0-9a-f]{2,4} ?)+)/gm)].map((m) => m[1].replace(/\s+/g, '')).join('');
    return hex.length > 0 ? hex : null;
  } catch {
    return null;
  }
}

/** Aantal videoframes volgens de container (pakketten tellen, geen decode). */
export async function telFrames(pad: string): Promise<number | null> {
  try {
    const uit = await run(resolveBinary('ffprobe'), [
      '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', pad,
    ]);
    const n = Number(uit.trim().split(/\s+/)[0]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Decodeert het hele beeldspoor en telt de frames. Goed = geen enkele
 * decodeerfout en (als opgegeven) precies het verwachte aantal frames.
 */
export async function controleerDecode(pad: string, verwachtFrames?: number | null): Promise<{ goed: boolean; frames: number | null; reden: string }> {
  const uit = await new Promise<{ code: number | null; stdout: string; stderr: string }>((klaar) => {
    const kind = spawn(resolveBinary('ffmpeg'), ['-nostdin', '-v', 'error', '-progress', 'pipe:1', '-i', pad, '-map', '0:v:0', '-f', 'null', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    kind.stdout.on('data', (d) => (stdout += d));
    kind.stderr.on('data', (d) => (stderr += d));
    kind.on('error', (e) => klaar({ code: -1, stdout, stderr: e.message }));
    kind.on('close', (code) => klaar({ code, stdout, stderr }));
  });
  const frames = Number([...uit.stdout.matchAll(/^frame=(\d+)/gm)].pop()?.[1] ?? NaN);
  const fouten = uit.stderr.trim();
  if (uit.code !== 0 || fouten) {
    return { goed: false, frames: Number.isFinite(frames) ? frames : null, reden: `decodeerfout: ${(fouten || `exit ${uit.code}`).split('\n')[0].slice(0, 120)}` };
  }
  if (verwachtFrames && Number.isFinite(frames) && frames !== verwachtFrames) {
    return { goed: false, frames, reden: `${frames} frames, basis heeft er ${verwachtFrames}` };
  }
  return { goed: true, frames: Number.isFinite(frames) ? frames : null, reden: 'ok' };
}

function runMetStderr(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let alles = '';
    child.stdout.on('data', (d) => (alles += d));
    child.stderr.on('data', (d) => (alles += d));
    child.on('error', () => reject(new Error(`${command} niet gevonden`)));
    child.on('close', (code) => (code === 0 ? resolve(alles) : reject(new Error(`${command} exit ${code}: ${alles.trim().slice(-300)}`))));
  });
}

/**
 * De zoom die een shot uit zichzelf verdient — één waarheid voor de render én
 * voor de kadercontrole. Toen de controle zijn eigen aanname (zoom 1) hanteerde
 * en terugschreef, verloor elk shot dat hij aanraakte zijn berekende inzoom:
 * dat was het "de zoom gebeurt niet"-slotshot.
 *
 * Bij een gevolgd shot dimensioneert de zoom op het kléínste gemeten gezicht:
 * het kader loopt toch mee, dus de enige vraag is of de spreker ook op zijn
 * verste moment groot in beeld staat. Zonder spoor geldt het bewegingsplafond.
 */
/**
 * De kleinste zoom waarbij het kader nog op dit punt kán centreren.
 *
 * Tegen-intuïtief maar meetkundig onvermijdelijk: hoe verder de spreker naar de
 * rand staat, hoe verder je moet ínzoomen om hem in het midden te krijgen. De
 * uitsnede is dan smaller en past dichter tegen de rand. Bij zoom 1 beslaat hij
 * een derde van de breedte en kan het midden dus nooit voorbij 0,84 komen;
 * staat de spreker op 0,9, dan is zoom 1,58 het minimum.
 */
function centreerbaarVanaf(focusX: number): number {
  const rand = Math.min(focusX, 1 - focusX);
  const max = instelling('ZOOM_MAX');
  if (rand <= 0.01) return max;
  return Math.min(max, (1080 / (1920 * (16 / 9))) / (2 * rand));
}

export function basisZoom(shot: Shot): number {
  const paneelBreed = shot.paneel ? shot.paneel[1] - shot.paneel[0] : 1;
  const inPaneel = (b?: number) => (b !== undefined ? b / paneelBreed : undefined);
  const breedte = shot.spoor?.length
    ? (inPaneel(shot.focusWmin) ?? inPaneel(shot.focusW))
    : inPaneel(shot.focusW);
  let zoom = vulZoom(breedte);

  // Het gezicht hoort in het midden. Kan dat niet bij deze zoom, dan zoomt hij
  // in tot het wél kan — bij een meelopend kader voor de meest naar de rand
  // gelegen stand van het spoor.
  const standen = shot.spoor?.length
    ? shot.spoor.map((punt) =>
        shot.paneel ? (punt.x - shot.paneel[0]) / (shot.paneel[1] - shot.paneel[0]) : punt.x,
      )
    : [shot.paneel && shot.focusX !== undefined
        ? (shot.focusX - shot.paneel[0]) / (shot.paneel[1] - shot.paneel[0])
        : (shot.focusX ?? 0.5)];
  const nodig = Math.max(...standen.map(centreerbaarVanaf));
  zoom = Math.max(zoom, nodig);

  if (!shot.spoor?.length) {
    zoom = Math.min(zoom, bewegingsPlafond(shot.spreiding, inPaneel(shot.focusW)));
  } else if ((shot.spreiding ?? 0) > 0.15) {
    // Grote glijbeweging (naar voren leunen, opstaan): het kader volgt, maar
    // agressief inzoomen wordt dan benauwd. Gematigd is hier het maximum dat
    // prettig kijkt — tenzij centreren méér vraagt, want in het midden staan
    // weegt zwaarder dan de kadergrootte.
    zoom = Math.min(zoom, Math.max(1.35, nodig));
  }
  return Math.max(1, Math.min(instelling('ZOOM_MAX'), zoom));
}

/**
 * Hoe ver je maximaal mag inzoomen zonder dat de spreker het kader uitloopt.
 * De uitsnede moet zijn hele bewegingsruimte plus zijn hoofd omvatten.
 */
function bewegingsPlafond(spreiding?: number, focusW?: number): number {
  if (!spreiding || spreiding < 0.02) return Infinity;
  const nodig = spreiding + (focusW ?? 0.12) * 1.4;
  const bijZoomEen = 1080 / (1920 * (16 / 9));
  return Math.max(1, bijZoomEen / Math.max(0.01, nodig));
}

/** Lengte van een audio- of videobestand in seconden; 0 als het niet te lezen is. */
async function duurVan(pad: string): Promise<number> {
  try {
    const uit = await run(resolveBinary('ffprobe'), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      pad,
    ]);
    const n = Number(uit.trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
