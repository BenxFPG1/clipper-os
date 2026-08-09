import 'dotenv/config';
import { db } from '../src/lib/supabase';
import { runScriptwriterForBrief } from '../src/lib/scriptwriter';

async function main() {
  const { data: brief } = await db()
    .from('briefs')
    .select('id, titel')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  console.log('briefing:', brief!.titel);
  const r = await runScriptwriterForBrief(brief!.id as string, 1);
  const sc = r.script as any;
  console.log('\n─ POORTRAPPORT:', JSON.stringify(sc.poortrapport));
  console.log('\n─ HOOKKANDIDATEN:');
  for (const k of sc.hook_kandidaten ?? []) console.log(`  [${k.formule}] "${k.tekst}" → ${k.waarom_afgevallen.slice(0, 80)}`);
  console.log('\n─ GEKOZEN HOOK:', JSON.stringify(sc.hook.gesproken), '| overlay:', JSON.stringify(sc.hook.tekst_overlay));
  console.log('\n─ SHOTS:');
  for (const sh of sc.shotlist ?? []) {
    const w = (sh.gesproken_tekst as string).split(/\s+/).length;
    console.log(`  ${sh.volgorde} [${sh.functie}] ${sh.seconde_van}-${sh.seconde_tot}s (${w}w): ${JSON.stringify(sh.gesproken_tekst).slice(0, 140)}`);
  }
  console.log('\n─ ZELFKRITIEK:', sc.zelfkritiek?.zwakste_punt?.slice(0, 250));
}
main();
