import 'dotenv/config';
import { haalNieuweBronvideos } from '../src/lib/ingest/kanaal';
async function main() {
  const r = await haalNieuweBronvideos();
  console.log(`\ntoegevoegd: ${r.toegevoegd.length}`);
  for (const v of r.toegevoegd) console.log('  +', v.campagne, '|', v.titel.slice(0, 60));
  console.log(`\nfouten (${r.fouten.length}):`);
  for (const f of r.fouten) console.log('  -', f.slice(0, 220));
}
main();
