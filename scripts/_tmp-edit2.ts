import 'dotenv/config';
import { runEditAgent } from '../src/lib/agents/edit';
async function main() {
  const r = await runEditAgent('c32bcff0-7582-49b9-b484-2f98ec3cc356', { opnieuw: true });
  console.log(`beslissingen voor ${r.clips.length} clips`);
  const kaders: Record<string, number> = {};
  const effecten: Record<string, number> = {};
  for (const c of r.clips) {
    kaders[c.kader] = (kaders[c.kader] ?? 0) + 1;
    for (const sh of c.shots) effecten[sh.beeld_effect] = (effecten[sh.beeld_effect] ?? 0) + 1;
  }
  console.log('kaders:', kaders);
  console.log('beeldingrepen:', effecten);
  const c = r.clips[0];
  console.log(`\nclip 1 — kader ${c.kader}, muziek ${c.muziek}`);
  if (c.stiltemoment) console.log(`stilte: ${c.stiltemoment.slice(0, 130)}`);
  for (const sh of c.shots.slice(0, 4)) {
    console.log(`  shot ${sh.volgorde}: focus ${sh.focus} | ${sh.beeld_effect} | sfx ${sh.sfx}${sh.tekstkaart ? ` | kaart "${sh.tekstkaart}"` : ''}`);
    console.log(`     ${sh.waarom.slice(0, 110)}`);
  }
  console.log(`eindcontrole: ${c.eindcontrole.slice(0, 200)}`);
  process.exit(0);
}
main().catch((e) => { console.error('FOUT:', e.message.slice(0, 300)); process.exit(1); });
