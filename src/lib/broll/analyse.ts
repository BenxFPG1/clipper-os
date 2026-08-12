import { spawn } from 'node:child_process';
import { resolveBinary } from '../ingest/binaries';

/**
 * Shotanalyse voor b-roll: wat zít er in een bestand, zonder één woord spraak.
 *
 * De gesprekspijplijn leunt volledig op het transcript — b-roll heeft er geen.
 * Wat een edit-planner voor b-roll nodig heeft is het visuele equivalent:
 * waar zitten de natuurlijke shotgrenzen (scènewissels), hoeveel beweegt er,
 * en hoe lang is alles. Puur mechanisch, geen model: dezelfde filosofie als
 * stiltedetectie bij spraak — de audio loog nooit, en het beeld ook niet.
 */

export type BrollScene = { t: number; score: number };

export type BrollAnalyse = {
  duur: number;
  breedte: number;
  hoogte: number;
  fps: number;
  /** Scènewissels: natuurlijke knippunten, met hoe hard het beeld daar omslaat (0..1). */
  scenes: BrollScene[];
  /** Gemiddelde beeldverandering per frame (0..1) — rustig statief vs. beweeglijk. */
  beweging: number;
};

/** Leest ffmpeg's scenedetectie-uitvoer: regels met pts_time en scene_score. */
export function parseScenes(uitvoer: string): BrollScene[] {
  const scenes: BrollScene[] = [];
  let laatsteT: number | null = null;
  for (const regel of uitvoer.split('\n')) {
    const tMatch = regel.match(/pts_time:([\d.]+)/);
    if (tMatch) {
      laatsteT = Number(tMatch[1]);
      continue;
    }
    const sMatch = regel.match(/lavfi\.scene_score=([\d.]+)/);
    if (sMatch && laatsteT !== null) {
      scenes.push({ t: Math.round(laatsteT * 100) / 100, score: Math.round(Number(sMatch[1]) * 1000) / 1000 });
      laatsteT = null;
    }
  }
  return scenes;
}

export async function analyseerBroll(pad: string): Promise<BrollAnalyse> {
  const probe = await run(resolveBinary('ffprobe'), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
    '-of', 'json',
    pad,
  ]);
  const info = JSON.parse(probe) as {
    streams?: { width: number; height: number; r_frame_rate: string }[];
    format?: { duration?: string };
  };
  const stream = info.streams?.[0];
  if (!stream) throw new Error('geen videostream gevonden');
  const [t, n] = stream.r_frame_rate.split('/').map(Number);
  const duur = Number(info.format?.duration ?? 0);

  // Scenedetectie met een lage drempel: we willen álle beeldveranderingen
  // zien, en pas in de planner beslissen wat een echte wissel is. De uitvoer
  // komt via metadata=print op stderr.
  const sceneUit = await run(resolveBinary('ffmpeg'), [
    '-i', pad,
    '-vf', "select='gte(scene,0.1)',metadata=print",
    '-an', '-f', 'null', '-',
  ], true);
  const scenes = parseScenes(sceneUit);

  // Beweging: het gemiddelde van alle frame-op-frame scene-scores (ook onder
  // de drempel) zou het eerlijkst zijn, maar dat vergt een tweede doorloop.
  // De dichtheid en hoogte van gedetecteerde veranderingen is een goede proxy:
  // veel wissels met hoge scores = beeldrijk materiaal.
  const beweging = duur > 0
    ? Math.min(1, scenes.reduce((som, s) => som + s.score, 0) / Math.max(duur, 1))
    : 0;

  return {
    duur: Math.round(duur * 100) / 100,
    breedte: stream.width,
    hoogte: stream.height,
    fps: n ? Math.round((t / n) * 100) / 100 : 25,
    scenes: scenes.slice(0, 200),
    beweging: Math.round(beweging * 1000) / 1000,
  };
}

function run(cmd: string, args: string[], stderrIsUitvoer = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const kind = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    kind.stdout.on('data', (d) => (stdout += d));
    kind.stderr.on('data', (d) => (stderr += d));
    kind.on('error', reject);
    kind.on('close', (code) => {
      // ffmpeg -f null eindigt met 0; metadata=print schrijft naar stderr.
      if (code === 0) resolve(stderrIsUitvoer ? stderr : stdout);
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-200)}`));
    });
  });
}
