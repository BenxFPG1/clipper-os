import 'dotenv/config';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { db } from '../src/lib/supabase';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { ytdlpAuthArgs } from '../src/lib/ingest/youtube';
import { Shot } from '../src/lib/roughcut';
import { bouwPremiereXml } from '../src/lib/roughcut/fcpxml';

/**
 * Maakt een Premiere/Resolve-project van een clip-plan: per clip een sequence
 * met de cuts los op de tijdlijn, plus de bronvideo in volle kwaliteit ernaast.
 *
 *   npm run project -- <video-id>
 *
 * Uitvoer in ~/Movies/Clipper OS/<titel>/: bron.mp4 + <titel>.xml.
 * Openen: Premiere -> File -> Import, of Resolve -> File -> Import Timeline.
 */
async function main() {
  const videoId = process.argv[2];
  if (!videoId) {
    console.error('Gebruik: npm run project -- <video-id>');
    process.exit(1);
  }

  const supabase = db();
  const { data: video, error } = await supabase
    .from('videos')
    .select('id, title, source_url')
    .eq('id', videoId)
    .single();
  if (error) throw error;
  if (!video.source_url) throw new Error('Deze video heeft geen bron-URL.');

  const { data: planRij, error: planError } = await supabase
    .from('clip_plans')
    .select('plan')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (planError) throw new Error('Geen clip-plan gevonden voor deze video.');

  const clips = ((planRij.plan as { clips?: unknown[] }).clips ?? []) as { titel_intern: string; shots: Shot[] }[];
  if (clips.length === 0) throw new Error('Het plan bevat geen clips.');

  const veiligeTitel = video.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60).trim() || 'video';
  const map = join(homedir(), 'Movies', 'Clipper OS', veiligeTitel);
  await mkdir(map, { recursive: true });
  const bronPad = join(map, 'bron.mp4');

  // De bron staat er misschien al van een eerdere montage-run; hergebruiken.
  const cacheBron = join(homedir(), 'Movies', 'Clipper OS', '.werk', videoId, 'bron.mp4');
  if (!existsSync(bronPad)) {
    if (existsSync(cacheBron)) {
      console.log('Bronvideo kopiëren uit cache…');
      await copyFile(cacheBron, bronPad);
    } else {
      console.log('Bronvideo downloaden (volle kwaliteit)…');
      await run(resolveBinary('yt-dlp'), [
        ...ytdlpAuthArgs(),
        '--no-warnings',
        '--extractor-args', 'youtube:player_client=default,tv',
        '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
        '--merge-output-format', 'mp4',
        '-o', bronPad,
        video.source_url,
      ]);
    }
  } else {
    console.log('Bronvideo staat er al.');
  }

  // Echte eigenschappen van de bron; het project moet daarop kloppen.
  const probe = await run(resolveBinary('ffprobe'), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate',
    '-of', 'json',
    bronPad,
  ]);
  const stream = (JSON.parse(probe).streams ?? [])[0] as { width: number; height: number; r_frame_rate: string };
  const [t, n] = stream.r_frame_rate.split('/').map(Number);
  const fps = n ? t / n : 25;

  const xml = bouwPremiereXml(
    veiligeTitel,
    { pad: bronPad, fps, breedte: stream.width, hoogte: stream.height },
    clips.map((c, i) => ({ nummer: i + 1, titel: c.titel_intern, shots: c.shots })),
  );

  const xmlPad = join(map, `${veiligeTitel}.xml`);
  await writeFile(xmlPad, xml);

  console.log(`\nKlaar: ${clips.length} sequences (${fps.toFixed(2)} fps, ${stream.width}x${stream.height})`);
  console.log(`  ${xmlPad}`);
  console.log(`  ${bronPad}`);
  console.log('\nPremiere: File → Import → kies de .xml. Resolve: File → Import Timeline.');
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exit ${code}: ${stderr.slice(-300)}`)),
    );
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
