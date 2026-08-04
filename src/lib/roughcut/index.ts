import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { ytdlpAuthArgs } from '../ingest/youtube';
import { focusNaarX, kaderKeten, type Kader } from './kader';
import { snapShots, verwijderDodeLucht, type SnapSegment, type Stilte } from './snap';

export type Shot = {
  volgorde: number;
  start: number;
  end: number;
  functie: string;
  edit_notitie?: string;
  /** Uit het plan: waar het verticale kader op richt. */
  focus?: 'links' | 'midden' | 'rechts';
  /** Gemeten gezichtspositie (0..1) uit de gezichtsdetectie. */
  focusX?: number;
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
  gesorteerd.forEach((shot, i) => {
    const duur = shot.end - shot.start;
    const zoom =
      shot.beeld_effect === 'punch_in' ? 1.12 : shot.beeld_effect === 'snelle_zoom' ? 1.18 : 1;
    const keten = kaderKeten(kader, { focusX: focusNaarX(shot.focus, shot.focusX), zoom });
    invoer.push('-ss', shot.start.toFixed(3), '-t', duur.toFixed(3), '-i', bronBestand);
    delenFilter.push(`[${i}:v]setpts=PTS-STARTPTS,fps=30,${keten},setsar=1[v${i}]`);
    delenFilter.push(
      `[${i}:a]asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=0.012,afade=t=out:st=${Math.max(0, duur - 0.012).toFixed(3)}:d=0.012,` +
        `aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`,
    );
  });
  const koppel = gesorteerd.map((_, i) => `[v${i}][a${i}]`).join('');
  let filter = `${delenFilter.join(';')};${koppel}concat=n=${gesorteerd.length}:v=1:a=1[vuit][auit]`;

  // Tekstkaarten en hook in het beeld branden: elke PNG als extra invoer, met
  // een tijdvenster waarin hij zichtbaar is.
  const overlays = opties.overlays ?? [];
  let laatsteV = 'vuit';
  overlays.forEach((o, n) => {
    const inputIndex = gesorteerd.length + n;
    invoer.push('-i', o.pad);
    const uitLabel = n === overlays.length - 1 ? 'vfinal' : `vo${n}`;
    filter += `;[${laatsteV}][${inputIndex}:v]overlay=0:0:enable='between(t\,${o.start.toFixed(2)}\,${o.end.toFixed(2)})'[${uitLabel}]`;
    laatsteV = uitLabel;
  });

  await run(resolveBinary('ffmpeg'), [
    '-y',
    ...invoer,
    '-filter_complex', filter,
    '-map', `[${laatsteV}]`, '-map', '[auit]',
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
  opties: { transcript?: SnapSegment[]; stiltes?: Stilte[] },
): (Shot & { subKnip?: boolean })[] {
  const gesnapt = snapShots(shots, opties.transcript ?? [], { stiltes: opties.stiltes });
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
