import 'dotenv/config';
import { db } from '../src/lib/supabase';
async function main() {
  const s = db();
  const { data } = await s.from('clip_plans').select('plan, edit_beslissingen').eq('video_id','a48414d1-cb86-4d88-9769-ebd22f80a096').order('created_at',{ascending:false}).limit(1).single();
  const clip = (data!.plan as any).clips[0];
  console.log('CLIP:', clip.titel_intern);
  for (const sh of clip.shots) console.log(` shot ${sh.volgorde} ${sh.functie} ${sh.start}-${sh.end} (${(sh.end-sh.start).toFixed(1)}s) "${(sh.transcript_fragment||'').slice(0,70)}"`);
  const e = (data!.edit_beslissingen as any)?.clips?.find((c:any)=>c.clip_nummer===1);
  console.log('EDIT kader:', e?.kader, 'muziek:', e?.muziek);
  for (const sh of e?.shots ?? []) console.log(` edit ${sh.volgorde}: focus=${sh.focus} effect=${sh.beeld_effect} sfx=${sh.sfx} kaart=${sh.tekstkaart ?? '-'}`);
}
main();
