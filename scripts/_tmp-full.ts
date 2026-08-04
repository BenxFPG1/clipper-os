import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { db } from '../src/lib/supabase';
import { maakRuweMontage, bepaalSegmenten } from '../src/lib/roughcut';
import { lijnShotsUit } from '../src/lib/roughcut/uitlijnen';

async function main() {
  const s = db();
  const id = 'c32bcff0-7582-49b9-b484-2f98ec3cc356';
  const { data: v } = await s.from('videos').select('source_url, transcript, stiltes').eq('id', id).single();
  const { data: p } = await s.from('clip_plans').select('plan').eq('video_id', id)
    .order('created_at', { ascending: false }).limit(1).single();
  const clip = ((p!.plan as { clips: { shots: never[]; titel_intern: string }[] }).clips)[0];
  const bron = join(homedir(), 'Movies', 'Clipper OS', 'RAAD DE VROUW', 'bron.mp4');

  const t0 = Date.now();
  const { shots, uitgelijnd } = await lijnShotsUit(bron, clip.shots, { log: (m) => console.log('  ', m) });
  console.log(`uitlijning in ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const [i, sh] of shots.entries()) {
    const oud = (clip.shots[i] as { start: number; end: number });
    const d = (x: number) => x.toFixed(1);
    console.log(`  shot ${i + 1}: ${d(oud.start)}-${d(oud.end)} -> ${d(sh.start)}-${d(sh.end)}`);
  }

  const segmenten = bepaalSegmenten(shots, { transcript: v!.transcript as never, stiltes: (v!.stiltes ?? []) as never, uitgelijnd: uitgelijnd > 0 });
  const r = await maakRuweMontage({
    sourceUrl: v!.source_url as string,
    shots: segmenten,
    alGesegmenteerd: true,
    outputPad: '/tmp/final-test.mp4',
    werkmap: join(homedir(), 'Movies', 'Clipper OS', 'RAAD DE VROUW'),
    kader: 'vullend',
    muziekPad: '/tmp/testbed.mp3',
    onVoortgang: (m) => console.log('  ', m),
  });
  console.log(`klaar: ${r.duur}s montage`);
}
main().catch((e) => console.error('FOUT:', e.message.slice(0, 400)));
