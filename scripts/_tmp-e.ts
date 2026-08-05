import 'dotenv/config';
import { runEditAgent } from '../src/lib/agents/edit';
const t0 = Date.now();
runEditAgent('c32bcff0-7582-49b9-b484-2f98ec3cc356', {
  onVoortgang: (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`),
}).then((r) => { console.log(`klaar: ${r.clips.length} clips`); process.exit(0); })
  .catch((e) => { console.error('FOUT:', e.message.slice(0, 200)); process.exit(1); });
