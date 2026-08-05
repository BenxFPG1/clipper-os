import { spawn } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { ytdlpAuthArgs } from '../ingest/youtube';

/**
 * Haalt beeldframes uit een video zodat Claude hem kan zien in plaats van
 * alleen lezen. Zonder beeld verzint een model alles wat visueel is: hoe een
 * hook gekaderd staat, welke tekststijl er ligt, hoe snel er geknipt wordt.
 *
 * De frameverdeling volgt waar de aandacht ligt: de eerste seconden dicht op
 * elkaar (daar valt de beslissing om te blijven kijken), daarna verspreid.
 * Het aantal is begrensd omdat elk frame flink meetelt in de tokenkosten.
 */
export async function pakFrames(
  bronUrl: string,
  opties: { maxFrames?: number; hookSeconden?: number; werkmap?: string } = {},
): Promise<{ map: string; frames: { pad: string; seconde: number }[]; duur: number | null }> {
  const maxFrames = opties.maxFrames ?? 12;
  const hookSeconden = opties.hookSeconden ?? 6;

  const map = opties.werkmap ?? (await mkdtemp(join(tmpdir(), 'clipper-frames-')));
  const video = join(map, 'bron.mp4');

  await run(resolveBinary('yt-dlp'), [
    ...ytdlpAuthArgs(),
    '--no-warnings',
    '--extractor-args', 'youtube:player_client=default,tv',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '-o', video,
    bronUrl,
  ]);

  const duur = await probeDuur(video);

  // Waar verandert het beeld écht? Vaste intervallen bemonsteren een statische
  // talking head te vaak en een snel geknipte reel te weinig. Daarom eerst de
  // scènewissels opzoeken; vaste intervallen zijn de vangnetlaag zodat er ook
  // bij weinig wissels genoeg te zien valt (dichtheidsvloer).
  const wissels = await zoekScenewissels(video);
  const tijden: number[] = [];

  // Hook altijd dicht bemonsterd: daar valt de kijkbeslissing.
  const inHook = Math.min(4, Math.max(2, Math.floor(maxFrames / 3)));
  for (let i = 0; i < inHook; i++) tijden.push((hookSeconden / inHook) * i + 0.4);

  // Daarna de scènewissels (die tonen de knippen), aangevuld met een
  // gelijkmatige spreiding als er te weinig wissels zijn.
  const naHook = wissels.filter((t) => t > hookSeconden);
  const ruimte = maxFrames - tijden.length;
  const stap = Math.max(1, Math.ceil(naHook.length / Math.max(1, Math.floor(ruimte * 0.7))));
  for (let i = 0; i < naHook.length && tijden.length < maxFrames * 0.85; i += stap) {
    tijden.push(naHook[i]);
  }
  if (duur && duur > hookSeconden) {
    const tekort = maxFrames - tijden.length;
    for (let i = 0; i < tekort; i++) {
      const t = hookSeconden + ((duur - hookSeconden) / (tekort + 1)) * (i + 1);
      // Niet vlak naast een frame dat we al hebben.
      if (!tijden.some((x) => Math.abs(x - t) < 1.5)) tijden.push(t);
    }
  }
  tijden.sort((a, b) => a - b);

  for (const [i, t] of tijden.entries()) {
    const naam = join(map, `f${String(i).padStart(2, '0')}-${Math.round(t)}s.jpg`);
    await run(resolveBinary('ffmpeg'), [
      '-nostdin', '-y',
      '-ss', t.toFixed(2),
      '-i', video,
      '-frames:v', '1',
      // Kleiner dan het origineel: voor kaderanalyse is 480 breed genoeg en het
      // scheelt fors in tokens.
      '-vf', 'scale=480:-2',
      '-q:v', '4',
      naam,
    ]).catch(() => undefined);
  }

  const bestanden = (await readdir(map))
    .filter((b) => b.endsWith('.jpg'))
    .sort();

  return {
    map,
    frames: bestanden.map((b) => ({
      pad: join(map, b),
      seconde: Number(b.match(/-(\d+)s\.jpg$/)?.[1] ?? 0),
    })),
    duur,
  };
}

/**
 * Zoekt de momenten waarop het beeld wezenlijk verandert. De drempel is laag
 * gezet (0,06): bij talking-head-materiaal, waar alleen de kadrering en de
 * spreker wisselen, vindt 0,25 vrijwel niets terwijl er wel degelijk geknipt
 * wordt. Faalt de detectie, dan is de lijst leeg en vallen we terug op de
 * gelijkmatige spreiding.
 */
async function zoekScenewissels(pad: string): Promise<number[]> {
  try {
    const uit = await new Promise<string>((klaar) => {
      const kind = spawn(resolveBinary('ffmpeg'), [
        '-nostdin', '-i', pad,
        '-filter:v', "select='gt(scene,0.06)',showinfo",
        '-f', 'null', '-',
      ]);
      let alles = '';
      kind.stdout.on('data', (d) => (alles += d));
      kind.stderr.on('data', (d) => (alles += d));
      kind.on('error', () => klaar(''));
      kind.on('close', () => klaar(alles));
    });

    return [...uit.matchAll(/pts_time:([\d.]+)/g)]
      .map((m) => Number(m[1]))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

async function probeDuur(pad: string): Promise<number | null> {
  try {
    const uit = await run(resolveBinary('ffprobe'), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      pad,
    ]);
    const n = Number(uit.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const kind = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    kind.stdout.on('data', (d) => (stdout += d));
    kind.stderr.on('data', (d) => (stderr += d));
    kind.on('error', reject);
    kind.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exit ${code}: ${stderr.slice(-200)}`)),
    );
  });
}
