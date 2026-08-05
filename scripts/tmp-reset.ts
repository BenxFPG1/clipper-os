import 'dotenv/config';
import { db } from '../src/lib/supabase';
async function main() {
  const s = db();
  const { data: v } = await s.from('videos').select('campaign_id').eq('id', 'a48414d1-cb86-4d88-9769-ebd22f80a096').single();
  // Huisstijl wissen zodat de agent hem opnieuw bepaalt.
  await s.from('campaigns').update({ huisstijl: null }).eq('id', v!.campaign_id!);
  const { error } = await s.from('render_jobs')
    .update({ status: 'wachtend', fout: null, voortgang: null, gestart_at: null, bestanden: [] })
    .eq('id', 'b3bbc4a9-e8f2-4413-a399-a74cc191998b');
  console.log(error ? error.message : 'huisstijl gewist + job teruggezet');
}
main();
