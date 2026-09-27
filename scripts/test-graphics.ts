/**
 * Tests voor graphics: de inhoudsmeting op echte GoldRepublic-frames (oranje
 * verloop met vignet, logo in de hoek — scripts/fixtures/) en de
 * leestijdregel (leestijd.ts) op gestubde deelstukken. Zonder netwerk.
 *
 * Draaien: npm run test:graphics
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { analyseerGraphic, inhoudKader } from '../src/lib/roughcut/graphics';
import { keurLeesbaar, leesLogregel, leestijd, leestijdPlan } from '../src/lib/roughcut/leestijd';
import { instelling } from '../src/lib/roughcut/instellingen';
import type { Shot } from '../src/lib/roughcut';

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

function pixels(bestand: string): Buffer {
  const r = spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-i', bestand, '-vf', 'scale=480:270', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e8 });
  return r.stdout;
}

console.log('inhoudsmeting op echte graphics (verloop + vignet + logo)');
for (const [naam, verwacht] of [
  ['graphic-voorraden.jpg', 'titel, balk, "< 3 maanden", bronregel'],
  ['graphic-39.jpg', 'titel, balk met record, "-39%", bronregel'],
] as const) {
  const { box, woorden } = analyseerGraphic(pixels(join(process.cwd(), 'scripts', 'fixtures', naam)), 480, 270);
  toets(`${naam}: betrouwbare box ondanks verloop`, box !== null, 'null');
  if (!box) continue;
  toets(`${naam}: box omvat de titel bovenaan`, box.y0 <= 0.1, JSON.stringify(box));
  toets(`${naam}: box omvat de bronregel onderaan`, box.y1 >= 0.93, JSON.stringify(box));
  toets(`${naam}: box omvat de grafiek links`, box.x0 <= 0.27, JSON.stringify(box));
  toets(`${naam}: box omvat de cijfers rechts`, box.x1 >= 0.7, JSON.stringify(box));
  toets(`${naam}: logo in de hoek telt niet (box niet beeldbreed)`, box.x1 < 0.8, JSON.stringify(box));
  const k = inhoudKader(box);
  const zoom = ((box.y1 - box.y0) / (k.r.y1 - k.r.y0)) * k.fgH / ((box.y1 - box.y0) * 607.5);
  toets(`${naam}: inzoom > 1,3x t.o.v. passend (${verwacht})`, zoom > 1.3, zoom.toFixed(2));
  toets(`${naam}: kadrering bevat de hele box`, k.r.x0 <= box.x0 && k.r.x1 >= box.x1 && k.r.y0 <= box.y0 && k.r.y1 >= box.y1);
  toets(`${naam}: leeseenheden geteld`, (woorden ?? 0) >= 8, String(woorden));
}

console.log('leestijd');
{
  toets('leestijd groeit met het aantal woorden', leestijd(2) < leestijd(8));
  toets('leestijd heeft een plafond', leestijd(100) === instelling('GRAPHIC_LEES_MAX'));
  toets('zonder telling de terugval', leestijd(null) === leestijd(instelling('GRAPHIC_LEES_TERUGVAL_WOORDEN')));

  // Shot A: spreker 2 s, dan een graphic van 1,3 s (4 woorden → 2,2 s nodig).
  // Shot B: spreker 2 s. De graphic moet 0,9 s blijven staan; B levert dat
  // aan zijn begin in.
  const a: Shot = {
    volgorde: 1, start: 4, end: 7.3, functie: 'setup',
    scenes: [{ van: 4, tot: 6, gezicht: true }, { van: 6, tot: 7.3, gezicht: false, leeswoorden: 4 }],
  };
  const b: Shot = { volgorde: 2, start: 3, end: 5, functie: 'escalatie' };
  const plan = leestijdPlan([a, b], 'vullend');
  const g = plan.graphics[0];
  toets('één graphic gevonden', plan.graphics.length === 1);
  toets('graphic 0,9 s vastgehouden tot zijn leestijd', Math.abs(g.vasthouden - 0.9) < 0.01 && Math.abs(g.getoond - 2.2) < 0.01, JSON.stringify(g));
  toets('volgend deelstuk levert precies dat in', plan.aanpassing.get('1:0')?.inkorten === g.vasthouden, JSON.stringify([...plan.aanpassing]));
  toets('keuring "graphics leesbaar" groen', keurLeesbaar([a, b], 'vullend').goed === true, keurLeesbaar([a, b], 'vullend').detail);
  toets('logregel noemt de verlenging', /1 verlengd \(\+0,9 s → 2,2 s\)/.test(leesLogregel(plan)), leesLogregel(plan));

  // Punchline erna: de spreker mag niet langer dan 3 s weg zijn.
  const lang: Shot = { ...a, end: 8.5, scenes: [{ van: 4, tot: 6, gezicht: true }, { van: 6, tot: 8.5, gezicht: false, leeswoorden: 12 }] };
  const punch: Shot = { volgorde: 2, start: 3, end: 6, functie: 'payoff' };
  const p2 = leestijdPlan([lang, punch], 'vullend');
  toets('punchline volgt: vasthouden begrensd op 3 s onzichtbaar', Math.abs(p2.graphics[0].getoond - instelling('GRAPHIC_MAX_ONZICHTBAAR')) < 0.01, JSON.stringify(p2.graphics[0]));
  toets('bewuste afweging is geen keuringsfout', keurLeesbaar([lang, punch], 'vullend').goed === true, keurLeesbaar([lang, punch], 'vullend').detail);

  // Volgend deelstuk te kort om in te leveren: review.
  const kortNa: Shot = { volgorde: 2, start: 3, end: 3.9, functie: 'escalatie' };
  const k3 = keurLeesbaar([a, kortNa], 'vullend');
  toets('geen ruimte om vast te houden → keuring review', k3.goed === false && /te kort/.test(k3.detail), k3.detail);

  // Een graphic die lang genoeg is blijft ongemoeid.
  const genoeg: Shot = { ...a, end: 9, scenes: [{ van: 4, tot: 6, gezicht: true }, { van: 6, tot: 9, gezicht: false, leeswoorden: 4 }] };
  toets('lang genoeg: geen aanpassing', leestijdPlan([genoeg, b], 'vullend').aanpassing.size === 0);
}

console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
if (gefaald > 0) process.exit(1);
