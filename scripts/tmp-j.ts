import 'dotenv/config';
import { db } from '../src/lib/supabase';
async function main() {
  const { data } = await db().from('render_jobs').select('status, voortgang, fout, klaar_at').eq('id','b3bbc4a9-e8f2-4413-a399-a74cc191998b').single();
  console.log(JSON.stringify(data));
}
main();
