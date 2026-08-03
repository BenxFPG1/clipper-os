import 'dotenv/config';
import { readFile, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../src/lib/supabase';
import { requireEnv } from '../src/lib/env';
import { Shot, maakRuweMontage } from '../src/lib/roughcut';

const BUCKET = 'montages';
/** Ruim onder de 50MB-limiet van de gratis opslag; grotere clips slaan we over. */
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Pakt wachtende renderopdrachten op en maakt de ruwe montages.
 *
 * Draait in GitHub Actions, niet op Vercel: video verwerken vraagt ffmpeg en
 * minuten rekentijd, en dat heeft serverless geen van beide. De site zet
 * alleen een opdracht klaar; deze worker doet het werk en zet het resultaat in
 * Supabase Storage, waar de site een downloadlink van maakt.
 */
async function main() {
  const supabase = db();

  const { data: jobs, error } = await supabase
    .from('render_jobs')
    .select('*, videos(title, source_url)')
    .eq('status', 'wachtend')
    .order('created_at')
    .limit(3);
  if (error) throw error;

  if (!jobs?.length) {
    console.log('Geen wachtende opdrachten.');
    return;
  }

  for (const job of jobs) {
    console.log(`\nOpdracht ${job.id} — ${job.titel ?? 'zonder titel'}`);
    await supabase
      .from('render_jobs')
      .update({ status: 'bezig', gestart_at: new Date().toISOString() })
      .eq('id', job.id);

    try {
      const bestanden = await verwerk(job);
      await supabase
        .from('render_jobs')
        .update({ status: 'klaar', bestanden, klaar_at: new Date().toISOString() })
        .eq('id', job.id);
      console.log(`  klaar: ${bestanden.length} bestand(en)`);
    } catch (e) {
      const fout = e instanceof Error ? e.message : String(e);
      console.error(`  MISLUKT: ${fout}`);
      await supabase
        .from('render_jobs')
        .update({ status: 'mislukt', fout: fout.slice(0, 500), klaar_at: new Date().toISOString() })
        .eq('id', job.id);
    }
  }
}

type Job = {
  id: string;
  video_id: string;
  clip_index: number | null;
  videos: { title: string; source_url: string | null } | null;
};

async function verwerk(job: Job) {
  const supabase = db();
  const video = job.videos;
  if (!video?.source_url) throw new Error('Video heeft geen bron-URL.');

  const { data: plan, error } = await supabase
    .from('clip_plans')
    .select('plan')
    .eq('video_id', job.video_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error) throw new Error('Geen clip-plan gevonden.');

  const clips = ((plan.plan as { clips?: unknown[] }).clips ?? []) as {
    titel_intern: string;
    shots: Shot[];
  }[];

  const teDoen =
    job.clip_index !== null
      ? [{ clip: clips[job.clip_index - 1], nummer: job.clip_index }].filter((x) => x.clip)
      : clips.map((clip, i) => ({ clip, nummer: i + 1 }));
  if (teDoen.length === 0) throw new Error('Geen clips in het plan.');

  const werkmap = await mkdtemp(join(tmpdir(), 'clipper-render-'));

  // De bron staat per video op een vaste plek, niet per opdracht. Vraag je
  // eerst clip 3 en daarna clip 7 aan, dan wordt dezelfde video niet twee keer
  // gedownload — en downloaden is verreweg de traagste stap.
  const bronmap = join(tmpdir(), 'clipper-bron', job.video_id);
  const bestanden: { naam: string; pad: string; bytes: number }[] = [];

  let bronBewaard = false;
  for (const { clip, nummer } of teDoen) {
    const naam = `${String(nummer).padStart(2, '0')}-${veilig(clip.titel_intern)}.mp4`;
    const lokaal = join(werkmap, naam);

    console.log(`  clip ${nummer}: ${clip.titel_intern}`);
    const montage = await maakRuweMontage({
      sourceUrl: video.source_url,
      shots: clip.shots,
      outputPad: lokaal,
      werkmap: bronmap,
      maxBytes: MAX_BYTES,
      onVoortgang: (m) => console.log(`     ${m}`),
    });

    // Gemeten broneigenschappen bewaren: daarmee genereert de site het
    // Premiere-projectbestand met de juiste framerate.
    if (!bronBewaard && montage.bron) {
      bronBewaard = true;
      await supabase
        .from('videos')
        .update({
          fps: montage.bron.fps,
          breedte: montage.bron.breedte,
          hoogte: montage.bron.hoogte,
        })
        .eq('id', job.video_id)
        .then(({ error: e }) => {
          if (e) console.log(`     broneigenschappen niet bewaard: ${e.message}`);
        });
    }

    const { size } = await stat(lokaal);
    if (size > MAX_BYTES) {
      console.log(`     overgeslagen: ${Math.round(size / 1e6)}MB past zelfs na comprimeren niet`);
      continue;
    }

    const pad = `${job.video_id}/${job.id}/${naam}`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(pad, await readFile(lokaal), { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new Error(`Uploaden mislukt: ${uploadError.message}`);

    bestanden.push({ naam, pad, bytes: size });
    console.log(`     geüpload (${Math.round(size / 1e6)}MB)`);
  }

  if (bestanden.length === 0) throw new Error('Niets geüpload; alle clips waren te groot of mislukten.');
  return bestanden;
}

function veilig(naam: string): string {
  return naam.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 45).trim().replace(/\s+/g, '-') || 'clip';
}

requireEnv('SUPABASE_SERVICE_ROLE_KEY');

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
