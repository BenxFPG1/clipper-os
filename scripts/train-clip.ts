/**
 * Eén trainingsronde voor één clip, op één machine: het fragment opnieuw
 * plannen met de huidige regels en de clip meteen renderen (alleen de
 * hoofdversie). Zo kost een ronde geen twee opstartrondes en geen wachtrij
 * tussen plan en render (trainingsrondes 1–4: ~30 min, waarvan het meeste
 * opzetten en wachten).
 *
 * Draaien (in CI via .github/workflows/train-clip.yml):
 *   npx tsx scripts/train-clip.ts <video-id> <van> <tot> "<titel>"
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { db } from '../src/lib/supabase';
import { runPlannerForVideo } from '../src/lib/planner/run';

async function main() {
  const [videoId, vanTekst, totTekst, titel = 'TRAIN'] = process.argv.slice(2);
  const van = Number(vanTekst);
  const tot = Number(totTekst);
  if (!videoId || !Number.isFinite(van) || !Number.isFinite(tot) || tot <= van) {
    throw new Error('gebruik: train-clip.ts <video-id> <van> <tot> "<titel>"');
  }
  const supabase = db();
  const t0 = Date.now();

  const { plan } = await runPlannerForVideo(videoId, { bereik: { van, tot } });
  const clip = plan.clips[0];
  if (!clip) throw new Error('het plan leverde geen clip');
  const tPlan = (Date.now() - t0) / 1000;
  console.log(`\nplan (${tPlan.toFixed(0)} s): ${clip.titel_intern} | overlay: ${clip.hook.tekst_overlay}`);
  for (const s of clip.shots) console.log(`  ${s.volgorde} ${s.functie} ${s.start}-${s.end}: ${(s.transcript_fragment ?? '').slice(0, 140)}`);

  // Direct op 'bezig': de gewone renderrij pakt hem dan niet tegelijk op.
  const { data: job, error } = await supabase
    .from('render_jobs')
    .insert({ video_id: videoId, clip_index: 1, titel, status: 'bezig', gestart_at: new Date().toISOString(), hartslag: new Date().toISOString(), aangevraagd_door: 'train' })
    .select('id')
    .single();
  if (error) throw error;
  console.log(`render ${job.id}`);

  const r = spawnSync('npx', ['tsx', 'scripts/render-worker.ts'], {
    stdio: 'inherit',
    env: { ...process.env, RENDER_JOB_ID: job.id, HOOK_VARIANTEN: '0' },
  });
  const tRender = (Date.now() - t0) / 1000 - tPlan;
  console.log(`\ntrainingsronde klaar: plan ${tPlan.toFixed(0)} s, render ${tRender.toFixed(0)} s, render-job ${job.id}`);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
