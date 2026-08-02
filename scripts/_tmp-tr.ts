import 'dotenv/config';
import { transcribeYoutube } from '../src/lib/ingest/whisper';
async function main() {
  const t = await transcribeYoutube('https://www.youtube.com/watch?v=RHoEShhMTuI');
  console.log(`titel: ${t.title}`);
  console.log(`segmenten: ${t.segments.length}, duur ${t.durationSeconds}s`);
  for (const s of t.segments.slice(0, 4)) {
    console.log(`  [${s.start_seconds.toFixed(1)}-${s.end_seconds.toFixed(1)}] ${s.text.slice(0, 70)}`);
  }
}
main().catch((e) => console.error('FOUT:', e.message));
