import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { ytdlpAuthArgs } from '../ingest/youtube';

export type Shot = {
  volgorde: number;
  start: number;
  end: number;
  functie: string;
  edit_notitie?: string;
};

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
  /** Maximale bestandsgrootte; groter wordt automatisch gecomprimeerd. */
  maxBytes?: number;
  onVoortgang?: (bericht: string) => void;
}): Promise<{ pad: string; duur: number }> {
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
      '--extractor-args', 'youtube:player_client=default,tv,ios',
      '-f',
      // Met terugval naar wat er wél is: datacenter-IP's krijgen van YouTube
      // vaak een beperktere formatenlijst dan een thuisverbinding.
      'bv*[height<=1080]+ba/b[height<=1080]/b',
      '--merge-output-format',
      'mp4',
      '-o',
      bronBestand,
      sourceUrl,
    ]);
  } else {
    log('Bronvideo staat al klaar.');
  }

  const gesorteerd = [...shots].sort((a, b) => a.volgorde - b.volgorde);
  const delen: string[] = [];
  let totaal = 0;

  for (const [i, shot] of gesorteerd.entries()) {
    const duur = shot.end - shot.start;
    if (duur <= 0) continue;

    const deel = join(werkmap, `deel-${String(i).padStart(3, '0')}.mp4`);
    log(`Shot ${i + 1}/${gesorteerd.length} knippen (${fmt(shot.start)}–${fmt(shot.end)}, ${shot.functie})…`);

    // Opnieuw encoderen in plaats van kopiëren: los kopiëren knipt alleen op
    // keyframes, waardoor je begin een halve seconde mis zit. Bij hooks is dat
    // precies het verschil tussen wel en niet werken.
    const schaal = opties.verticaal === false
      ? []
      : ['-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'];

    await run(resolveBinary('ffmpeg'), [
      '-y',
      '-ss', String(shot.start),
      '-i', bronBestand,
      '-t', String(duur),
      ...schaal,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '192k',
      '-r', '30',
      deel,
    ]);

    delen.push(deel);
    totaal += duur;
  }

  if (delen.length === 0) throw new Error('Alle shots hadden een ongeldige lengte.');

  log('Shots aan elkaar plakken…');
  const lijst = join(werkmap, 'delen.txt');
  await writeFile(lijst, delen.map((d) => `file '${d.replace(/'/g, "'\\''")}'`).join('\n'));

  await run(resolveBinary('ffmpeg'), [
    '-y', '-f', 'concat', '-safe', '0', '-i', lijst,
    '-c', 'copy',
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

  // Losse delen weggooien, bronvideo bewaren voor de volgende clip.
  for (const d of delen) await rm(d, { force: true });
  await rm(lijst, { force: true });

  return { pad: outputPad, duur: Math.round(totaal) };
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

function fmt(seconden: number): string {
  const m = Math.floor(seconden / 60);
  const s = Math.round(seconden % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
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
