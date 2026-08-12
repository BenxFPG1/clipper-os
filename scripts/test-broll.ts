/**
 * Tests voor de pure delen van de b-roll-keten: de scène-parser en de
 * mechanische planreparatie. Geen video, geen model — zelfde patroon als de
 * andere poort-tests, en dus geschikt voor elke CI-run.
 *
 * Draaien: npm run test:broll
 */
import { parseScenes } from '../src/lib/broll/analyse';
import { repareerPlan, type BrollPlan } from '../src/lib/broll/plan';

let gefaald = 0;
let gedaan = 0;

function toets(naam: string, voorwaarde: boolean, detail = '') {
  gedaan++;
  if (voorwaarde) console.log(`  ✓ ${naam}`);
  else {
    gefaald++;
    console.log(`  ✗ ${naam}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('parseScenes leest ffmpeg metadata=print');
{
  const uitvoer = [
    'frame:0    pts:12800  pts_time:0.512',
    'lavfi.scene_score=0.482',
    'frame:1    pts:76800  pts_time:3.072',
    'lavfi.scene_score=0.911',
    'iets anders dat genegeerd moet worden',
    'frame:2    pts:100000 pts_time:4.000',
  ].join('\n');
  const scenes = parseScenes(uitvoer);
  toets('twee complete scènes gelezen', scenes.length === 2, JSON.stringify(scenes));
  toets('tijden en scores kloppen', scenes[0]?.t === 0.51 && scenes[1]?.score === 0.911, JSON.stringify(scenes));
}
{
  toets('lege uitvoer geeft lege lijst', parseScenes('').length === 0);
}

console.log('repareerPlan');
const basisClip = (shots: BrollPlan['clips'][number]['shots']): BrollPlan['clips'][number] => ({
  titel_intern: 'test',
  verhaalidee: 'van breed naar dichtbij',
  hook_overlay: 'Kijk dit',
  muziek: 'energiek',
  shots,
  caption: { tiktok: 'x?', reels: 'x?', shorts: 'x?' },
  score: 7,
});
const shot = (volgorde: number, video_id: string, start: number, end: number) => ({
  volgorde,
  video_id,
  start,
  end,
  waarom_hier: 'test',
  overlay_tekst: null,
  spanning: 5,
});
{
  // Tijden buiten het bestand worden ingeklemd, onbruikbare bronnen vervallen.
  const plan: BrollPlan = {
    vorm: 'broll',
    clips: [
      basisClip([
        shot(1, 'a', 0, 3),
        shot(2, 'b', 2, 99), // langer dan het bestand: inklemmen op duur
        shot(3, 'c', 0, 2), // onbruikbaar: vervalt
        shot(4, 'a', 4, 6),
      ]),
    ],
  };
  const materiaal = [
    { video_id: 'a', duur: 10, bruikbaar: true },
    { video_id: 'b', duur: 8, bruikbaar: true },
    { video_id: 'c', duur: 5, bruikbaar: false },
  ];
  const uit = repareerPlan(plan, materiaal);
  const shots = uit.clips[0].shots;
  toets('onbruikbaar shot vervalt', shots.length === 3, `shots=${shots.length}`);
  toets('eind ingeklemd op bestandsduur', shots.find((s) => s.video_id === 'b')?.end === 8);
  toets('volgorde hernummerd 1..n', shots.map((s) => s.volgorde).join(',') === '1,2,3');
}
{
  // Een clip die na reparatie onder de 3 shots zakt, vervalt helemaal.
  const plan: BrollPlan = {
    vorm: 'broll',
    clips: [basisClip([shot(1, 'x', 0, 3), shot(2, 'a', 0, 2), shot(3, 'a', 3, 5)])],
  };
  const uit = repareerPlan(plan, [{ video_id: 'a', duur: 10, bruikbaar: true }]);
  toets('clip met te weinig geldige shots vervalt', uit.clips.length === 0, `clips=${uit.clips.length}`);
}
{
  // Sorteren op score: de sterkste clip eerst.
  const plan: BrollPlan = {
    vorm: 'broll',
    clips: [
      { ...basisClip([shot(1, 'a', 0, 2), shot(2, 'a', 3, 5), shot(3, 'a', 6, 8)]), score: 5 },
      { ...basisClip([shot(1, 'a', 0, 2), shot(2, 'a', 3, 5), shot(3, 'a', 6, 8)]), score: 9 },
    ],
  };
  const uit = repareerPlan(plan, [{ video_id: 'a', duur: 10, bruikbaar: true }]);
  toets('gesorteerd op score aflopend', uit.clips[0].score === 9);
}

console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
process.exit(gefaald === 0 ? 0 : 1);
