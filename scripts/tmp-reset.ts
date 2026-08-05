import 'dotenv/config';
import { db } from '../src/lib/supabase';
async function main() {
  const { error } = await db().from('render_jobs')
    .update({ status: 'wachtend', fout: null, voortgang: null, gestart_at: null, bestanden: [] })
    .eq('id', 'b3bbc4a9-e8f2-4413-a399-a74cc191998b');
  console.log(error ? error.message : 'teruggezet');
}
main();
