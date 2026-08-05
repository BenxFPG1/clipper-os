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

  // Tijdstippen kiezen: een derde van de frames in de hook, de rest verspreid
  // over de rest van de video.
  const inHook = Math.min(4, Math.floor(maxFrames / 3));
  const tijden: number[] = [];
  for (let i = 0; i < inHook; i++) tijden.push((hookSeconden / inHook) * i + 0.4);
  if (duur && duur > hookSeconden) {
    const rest = maxFrames - inHook;
    for (let i = 0; i < rest; i++) {
      tijden.push(hookSeconden + ((duur - hookSeconden) / (rest + 1)) * (i + 1));
    }
  }

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
