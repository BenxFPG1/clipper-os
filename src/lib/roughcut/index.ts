import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { ytdlpAuthArgs } from '../ingest/youtube';
import { kaderFilter, standaardKader, type Kader } from './kader';
import { snapShots, type SnapSegment, type Stilte } from './snap';

export type Shot = {
  volgorde: number;
  start: number;
  end: number;
  functie: string;
  edit_notitie?: string;
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
  /** Maximale bestandsgrootte; groter wordt automatisch gecomprimeerd. */
  maxBytes?: number;
  onVoortgang?: (bericht: string) => void;
}): Promise<{ pad: string; duur: number; bron: BronEigenschappen | null }> {
  const { sourceUrl, shots, outputPad, werkmap } = opties;
  const log = opties.onVoortgang ?? (() => {});

  if (shots.length === 0) throw new Error('Geen shots om te monteren.');

  await mkdir(werkmap, { recursive: true });
  const bronBestand = join(werkmap, 'bron.mp4');

  // De bronvideo halen we één keer op en hergebruiken we voor alle clips uit
  // dezelfde video; downloaden is verreweg de traagste stap.
  if (!existsSync(bronBestand)) {
    log('Bronvideo downloaden…');
    await run(resolveBinary('yt-dlp'), [
      ...ytdlpAuthArgs(),
      '--no-warnings',
      // YouTube geeft datacenter-IP's via de standaardclient geen formaten
      // ("Requested format is not available", ongeacht de formaatkeuze). De
      // tv- en ios-profielen krijgen ze wel.
      '--extractor-args', 'youtube:player_client=default,tv',
      '-f',
      // H.264 (avc1) plus AAC-audio (m4a): YouTube levert standaard AV1 en
      // Opus, en Premiere kan geen van beide lezen. Met terugval naar wat er
      // wél is, want datacenter-IP's krijgen een beperktere formatenlijst.
      'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[vcodec^=avc1][height<=1080]/bv*[height<=1080]+ba[ext=m4a]/b[height<=1080]/b',
      '--merge-output-format',
      'mp4',
      '-o',
      bronBestand,
      sourceUrl,
    ]);
  } else {
    log('Bronvideo staat al klaar.');
  }

  // Eigenschappen van de bron meten; de aanroeper bewaart ze in de database
  // zodat het Premiere-projectbestand framerate-correct gegenereerd kan worden.
  let bronInfo: BronEigenschappen | null = null;
  try {
    bronInfo = await probeBron(bronBestand);
  } catch {
    // Niet fataal: de montage zelf heeft de meting niet nodig.
  }

  // Knippunten naar de spraakpauzes schuiven: het model noteert tijdcodes op de
  // seconde, waardoor elke knip midden in een woord viel.
  const gesnapt = snapShots(shots, opties.transcript ?? [], {
    stiltes: opties.stiltes,
    duur: bronInfo ? undefined : undefined,
  });
  const gesorteerd = [...gesnapt].sort((a, b) => a.volgorde - b.volgorde).filter((s) => s.end > s.start);
  if (gesorteerd.length === 0) throw new Error('Alle shots hadden een ongeldige lengte.');

  const totaleDuur = gesorteerd.reduce((som, sh) => som + (sh.end - sh.start), 0);
  const totaal = totaleDuur;

  // Weten we vooraf hoe groot het mag worden, dan leggen we meteen een plafond
  // op de bitrate in plaats van achteraf een tweede keer te encoderen.
  const plafond =
    opties.maxBytes && totaleDuur > 0
      ? Math.max(800_000, Math.floor(((opties.maxBytes * 8) / totaleDuur) * 0.85) - 192_000)
      : null;
  const bitrateGrens = plafond ? ['-maxrate', String(plafond), '-bufsize', String(plafond * 2)] : [];

  const kader: Kader = opties.verticaal === false ? 'origineel' : (opties.kader ?? 'staand');
  const kaderArg = kaderFilter(kader);
  const kaderKeten = kaderArg.length ? kaderArg[1] : 'null';

  log(`Monteren in één doorloop (${gesorteerd.length} shots, kader: ${kader})…`);

  // Eén ffmpeg-opdracht, maar met de bron per shot apart als invoer én met
  // -ss vóór -i. Dat laatste is essentieel: met alleen trim-filters decodeert
  // ffmpeg voor élk shot de hele video vanaf het begin, wat op een runner met
  // beperkt geheugen na een paar minuten wordt afgeschoten. Met een zoekactie
  // per invoer springt hij direct naar het fragment.
  const invoer: string[] = [];
  const delenFilter: string[] = [];
  gesorteerd.forEach((shot, i) => {
    const duur = shot.end - shot.start;
    invoer.push('-ss', shot.start.toFixed(3), '-t', duur.toFixed(3), '-i', bronBestand);
    delenFilter.push(`[${i}:v]setpts=PTS-STARTPTS,fps=30,${kaderKeten},setsar=1[v${i}]`);
    delenFilter.push(
      `[${i}:a]asetpts=PTS-STARTPTS,` +
        // Korte fade op elke naad: zonder dit hoor je een klik op de overgang.
        `afade=t=in:st=0:d=0.012,afade=t=out:st=${Math.max(0, duur - 0.012).toFixed(3)}:d=0.012,` +
        `aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`,
    );
  });
  const koppel = gesorteerd.map((_, i) => `[v${i}][a${i}]`).join('');
  const filter = `${delenFilter.join(';')};${koppel}concat=n=${gesorteerd.length}:v=1:a=1[vuit][auit]`;

  await run(resolveBinary('ffmpeg'), [
    '-y',
    ...invoer,
    '-filter_complex', filter,
    '-map', '[vuit]', '-map', '[auit]',
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
