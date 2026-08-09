import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { ytdlpAuthArgs } from '../ingest/youtube';
import { effectKeten, focusNaarX, kaderKeten, spoorExpressie, type Kader } from './kader';
import { snapShots, verwijderDodeLucht, type SnapSegment, type Stilte } from './snap';

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
  beeld_effect?: string;
};

export type BurnOverlay = {
  /** Absoluut pad naar een transparante PNG van 1080x1920. */
  pad: string;
  /** Zichtbaar van/tot, in seconden op de tijdlijn van de montage. */
  start: number;
  end: number;
};

export type BronEigenschappen = { fps: number; breedte: number; hoogte: number };

/** Meet framerate en afmetingen van een bronbestand met ffprobe. */
export async function probeBron(pad: string): Promise<BronEigenschappen> {
  const uit = await run(resolveBinary('ffprobe'), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate',
    '-of', 'json',
    pad,
  ]);
  const stream = (JSON.parse(uit).streams ?? [])[0] as {
    width: number;
    height: number;
    r_frame_rate: string;
  };
  const [t, n] = stream.r_frame_rate.split('/').map(Number);
  return { fps: n ? t / n : 25, breedte: stream.width, hoogte: stream.height };
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
  onVoortgang?: (bericht: string) => void;
}): Promise<{ pad: string; duur: number; bron: BronEigenschappen | null }> {
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

  const plafond =
    opties.maxBytes && totaleDuur > 0
      ? Math.max(800_000, Math.floor(((opties.maxBytes * 8) / totaleDuur) * 0.85) - 192_000)
      : null;
  const bitrateGrens = plafond ? ['-maxrate', String(plafond), '-bufsize', String(plafond * 2)] : [];

  const kader: Kader = opties.verticaal === false ? 'origineel' : (opties.kader ?? 'vullend');
  log(`Monteren in één doorloop (${gesorteerd.length} segmenten, kader: ${kader})…`);

  // Bron per shot als eigen invoer met -ss vóór -i: ffmpeg springt dan direct
  // naar het fragment in plaats van de hele video te decoderen (dat werd op de
  // runner afgeschoten). Per shot een eigen kaderketen: focuspunt en punch-in
  // verschillen per shot.
  const invoer: string[] = [];
  const delenFilter: string[] = [];
  let vorigeZoom = 1;
  gesorteerd.forEach((shot, i) => {
    const duur = shot.end - shot.start;
    // Basis-zoom uit de gekozen ingreep, plus een correctie als de spreker
    // klein in beeld staat. Bij een tweeshot of een wijd camerastandpunt vult
    // een 1:1 uitsnede het verticale kader met vooral decor; dan hoort er
    // ingezoomd te worden tot het hoofd het beeld draagt.
    const ingreepZoom =
      shot.beeld_effect === 'punch_in' ? 1.12 : shot.beeld_effect === 'snelle_zoom' ? 1.18 : 1;
    const gemetenBreedte =
      shot.paneel && shot.focusW ? shot.focusW / (shot.paneel[1] - shot.paneel[0]) : shot.focusW;
    // Heeft de kadercontrole een zoom vastgesteld, dan wint die: hij is
    // getoetst tegen het werkelijke gezichtsvak.
    //
    // Beweegt de spreker binnen het shot, dan zetten we de zoom niet uit maar
    // begrenzen we hem: zo ver inzoomen als kan zonder dat hij het kader
    // uitloopt. "Bij twijfel wijd" leverde een slotshot op waarin hij klein
    // wegviel tussen het decor.
    let zoom = shot.zoom ?? Math.max(ingreepZoom, basisZoom(shot));
    // Jump-cut afdekken (editcraft): een knip binnen dezelfde opname is
    // zichtbaar als een hapering. Dat geldt voor de dode-luchtknippen én voor
    // elk paar opeenvolgende shots dat in de bron vrijwel aansluit (zelfde
    // camera, zelfde houding). Een schaalverschil van ruim 10% maakt er een
    // bewuste punch-in van; zonder dat verschil leest de naad als "niet
    // smooth". Gevolgde shots slaan we over — daar beweegt het kader al.
    const vorige = i > 0 ? gesorteerd[i - 1] : null;
    const doorloop =
      (shot as { subKnip?: boolean }).subKnip ||
      (vorige !== null && shot.start - vorige.end > -0.1 && shot.start - vorige.end < 2.5);
    if (doorloop && !shot.spoor?.length && Math.abs(zoom - vorigeZoom) < 0.08) {
      // Altijd eerst omhóóg: een naadknip hoort een punch-in te zijn. Omlaag
      // gaf precies de klacht "de zoom gebeurt niet" — het vervolgshot werd
      // wijder en de tweeshot kwam terug in beeld.
      zoom = vorigeZoom + 0.12 <= 1.7 ? vorigeZoom + 0.12 : Math.max(1, vorigeZoom - 0.12);
    }
    vorigeZoom = zoom;
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
    // In een half zo breed paneel is hetzelfde hoofd twee keer zo groot; de
    // vulzoom moet dus met die schaal meerekenen.
    const breedteInPaneel =
      paneel && shot.focusW ? shot.focusW / (paneel[1] - paneel[0]) : shot.focusW;

    // Volgt de uitsnede de spreker? Het spoor staat in absolute brontijd en
    // wordt hier pas omgerekend naar shot-tijd — zo overleeft het elke latere
    // grensverschuiving.
    const spoorInPaneel = shot.spoor?.map((punt) => ({
      t: punt.t - shot.start,
      x: paneel ? (punt.x - paneel[0]) / (paneel[1] - paneel[0]) : punt.x,
    }));
    const spoorYRel = shot.spoorY?.map((punt) => ({ t: punt.t - shot.start, x: punt.x }));
    const keten = kaderKeten(kader, {
      focusX: focusNaarX(shot.focus, focusInPaneel),
      focusExpr: spoorInPaneel ? (spoorExpressie(spoorInPaneel) ?? undefined) : undefined,
      zoom,
      focusY: shot.focusY,
      focusYExpr: spoorYRel ? (spoorExpressie(spoorYRel) ?? undefined) : undefined,
    });
    const effect = effectKeten(shot.beeld_effect, duur);
    invoer.push('-ss', shot.start.toFixed(3), '-t', duur.toFixed(3), '-i', bronBestand);
    delenFilter.push(
      `[${i}:v]setpts=PTS-STARTPTS,fps=30,${paneelKnip}${keten}${effect ? `,${effect}` : ''},setsar=1[v${i}]`,
    );
    // Naadfades. Normaal 12ms — net genoeg om een klik te voorkomen. Kon de
    // knipcontrole geen pauze vinden, dan valt de knip middenin spraak en helpt
    // een langere fade: 70ms klinkt als een zachte overgang in plaats van een
    // afgebroken woord.
    // Zit er geen stilte naast de knip, dan verzacht een langere fade de
    // overgang. 0,09s valt binnen de natuurlijke uitklank van een woord: lang
    // genoeg om het abrupte eraf te halen, kort genoeg om niet te horen als
    // een wegdraaiend volume.
    const fadeIn = shot.zachtBegin ? 0.09 : 0.012;
    const fadeUit = shot.zachtEind ? 0.09 : 0.012;
    delenFilter.push(
      `[${i}:a]asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${Math.max(0, duur - fadeUit).toFixed(3)}:d=${fadeUit},` +
        `aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`,
    );
  });
  const koppel = gesorteerd.map((_, i) => `[v${i}][a${i}]`).join('');
  let filter = `${delenFilter.join(';')};${koppel}concat=n=${gesorteerd.length}:v=1:a=1[vuit][aruw]`;

  // Spraak schoonmaken. Ruisonderdrukking (afftdn) is een grof middel: op
  // schone studio-audio hoor je hem als een blikkerig, onderwaterachtig randje
  // om de stem. Hij gaat daarom alleen aan als er werkelijk iets onder de
  // spraak zit — muziek of ruis in de bron — gemeten aan de ruisvloer tijdens
  // de spraakpauzes. Highpass en luidheid blijven altijd staan: die zijn
  // onhoorbaar goed.
  const ruis = opties.ruisvloerDb ?? null;
  const ruisig = ruis !== null && ruis > -45;
  filter += ruisig
    ? `;[aruw]highpass=f=75,afftdn=nf=-22,speechnorm=e=6.25:r=0.00001:l=1[aspraak]`
    : `;[aruw]highpass=f=75,speechnorm=e=5:r=0.00001:l=1[aspraak]`;
  let audioUit = 'aspraak';

  // Tijdvensters op de uiteindelijke tijdlijn waarin de muziek volledig stil
  // moet zijn: payoff-shots en shots met sfx 'stilte'. Dit is het
  // muziek-valt-weg-moment dat de onthulling groot maakt.
  const stilteVensters: { van: number; tot: number }[] = [];
  {
    let cursor = 0;
    for (const shot of gesorteerd) {
      const duur = shot.end - shot.start;
      if (shot.functie === 'payoff' || shot.sfx === 'stilte') {
        stilteVensters.push({ van: Math.max(0, cursor - 0.4), tot: cursor + duur });
      }
      cursor += duur;
    }
  }

  const extraInvoer: string[] = [];
  let extraIndex = gesorteerd.length;

  if (opties.muziekPad && existsSync(opties.muziekPad)) {
    // Het bed net zo vaak herhalen als nodig en dan hard afkappen. Met
    // `-stream_loop -1` is de invoer oneindig; die liep in combinatie met de
    // sidechain-ducking niet meer af en de render hing.
    const bedDuur = await duurVan(opties.muziekPad);
    const rondes = bedDuur > 0 ? Math.max(0, Math.ceil(totaleDuur / bedDuur)) : 0;
    extraInvoer.push('-stream_loop', String(rondes), '-i', opties.muziekPad);

    const stilExpr = stilteVensters.length
      ? stilteVensters.map((v) => `between(t\,${v.van.toFixed(2)}\,${v.tot.toFixed(2)})`).join('+')
      : '0';

    // Ducking in twee lagen. De sidechain volgt de spraak op de voet (snel
    // dicht, traag open, zodat hij niet tussen twee woorden omhoog pompt), en
    // daar bovenop staat de harde nul op de payoff: dát is het moment dat
    // groot moet worden, en een compressor alleen krijgt hem nooit ver genoeg
    // omlaag.
    filter +=
      `;[${extraIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
      `atrim=0:${(totaleDuur + 0.5).toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=1.2,afade=t=out:st=${Math.max(0, totaleDuur - 1.2).toFixed(3)}:d=1.2,` +
      `volume='if(${stilExpr}\,0\,0.34)':eval=frame[muz]` +
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

  // Geluidseffecten: elk aanwezig sfx-bestand klinkt op het begin van zijn shot.
  if (opties.sfxMap) {
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

  // Tot slot de hele mix op één luidheid zetten. Social-platforms mikken rond
  // -14 LUFS; zit je daaronder dan klinkt je clip zwak naast de rest van de
  // feed, zit je erboven dan draaien ze hem zelf terug. De limiter houdt de
  // ware piek onder -1,5 dBFS zodat de omzetting naar AAC bij het platform
  // niet alsnog gaat klippen.
  filter += `;[${audioUit}]loudnorm=I=-14:TP=-1.5:LRA=9,alimiter=limit=0.86:level=disabled[aklaar]`;
  audioUit = 'aklaar';

  invoer.push(...extraInvoer);

  // Tekstkaarten en hook in het beeld branden: elke PNG als extra invoer, met
  // een tijdvenster waarin hij zichtbaar is.
  const overlays = opties.overlays ?? [];
  let laatsteV = 'vuit';
  overlays.forEach((o, n) => {
    const inputIndex = extraIndex + n;
    invoer.push('-i', o.pad);
    const uitLabel = n === overlays.length - 1 ? 'vfinal' : `vo${n}`;
    filter += `;[${laatsteV}][${inputIndex}:v]overlay=0:0:enable='between(t\,${o.start.toFixed(2)}\,${o.end.toFixed(2)})'[${uitLabel}]`;
    laatsteV = uitLabel;
  });

  await run(resolveBinary('ffmpeg'), [
    '-y',
    ...invoer,
    '-filter_complex', filter,
    '-map', `[${laatsteV}]`, '-map', `[${audioUit}]`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    ...bitrateGrens,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    outputPad,
  ]);

  // Past het bestand niet binnen de opslaglimiet, dan comprimeren we het naar
  // een bitrate die wél past. Liever iets minder scherp dan helemaal geen
  // montage: dit is werkmateriaal voor de editor, geen eindproduct.
  if (opties.maxBytes) {
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
  return { pad: outputPad, duur: Math.round(totaal), bron: bronInfo };
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
): Promise<string> {
  await mkdir(werkmap, { recursive: true });
  const bronBestand = join(werkmap, 'bron.mp4');

  if (!existsSync(bronBestand)) {
    log('Bronvideo downloaden…');
    await run(resolveBinary('yt-dlp'), [
      ...ytdlpAuthArgs(),
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=default,tv',
      '-f',
      'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[vcodec^=avc1][height<=1080]/bv*[height<=1080]+ba[ext=m4a]/b[height<=1080]/b',
      '--merge-output-format', 'mp4',
      '-o', bronBestand,
      sourceUrl,
    ]);
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
  const gewenst = 0.45;
  return Math.min(1.7, Math.max(1, gewenst / inUitsnede));
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
  if (rand <= 0.01) return 1.7;
  return Math.min(1.7, (1080 / (1920 * (16 / 9))) / (2 * rand));
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
  return Math.max(1, Math.min(1.7, zoom));
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
