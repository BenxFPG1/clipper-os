/**
 * Snelle tests voor de poort en de keuringsregels.
 *
 * Deze draaien zonder video, zonder netwerk en zonder model: puur rekenwerk op
 * verzonnen woordlijsten. Daarom kunnen ze bij élke wijziging draaien — en dat
 * is het punt. De regressies die deze tool steeds opnieuw sloopten waren geen
 * exotische gevallen maar precies deze: een knip die in een woord landt, twee
 * shots die hetzelfde fragment gebruiken, een segment dat na alle correcties
 * niets meer voorstelt.
 *
 * Draaien: npm run test:poort
 */
import { poort, woordOnder } from '../src/lib/roughcut/poort';
import { keurKnippen, keurOverlap } from '../src/lib/roughcut/keuring';
import { corrigeerKadrering, uitsnedeVan } from '../src/lib/roughcut/kadercontrole';
import type { Shot } from '../src/lib/roughcut';
import type { BronWoord } from '../src/lib/roughcut/woorden';

let gefaald = 0;
let gedaan = 0;

function toets(naam: string, voorwaarde: boolean, detail = '') {
  gedaan++;
  if (voorwaarde) {
    console.log(`  ✓ ${naam}`);
  } else {
    gefaald++;
    console.log(`  ✗ ${naam}${detail ? ` — ${detail}` : ''}`);
  }
}

/** "ik wou dat mijn collega hier zat" met realistische woordtijden. */
const woorden: BronWoord[] = [
  { w: 'ik', s: 10.0, e: 10.18 },
  { w: 'wou', s: 10.2, e: 10.45 },
  { w: 'dat', s: 10.47, e: 10.7 },
  { w: 'mijn', s: 10.75, e: 11.0 },
  { w: 'collega', s: 11.05, e: 11.6 },
  { w: 'hier', s: 11.65, e: 11.9 },
  { w: 'zat', s: 11.95, e: 12.3 },
  { w: 'Philippe', s: 12.9, e: 13.5 },
  { w: 'Gijssel', s: 13.55, e: 14.2 },
];

const shot = (volgorde: number, start: number, end: number): Shot => ({
  volgorde,
  start,
  end,
  functie: 'setup',
});

console.log('woordOnder');
toets('herkent een tijdstip middenin een woord', woordOnder(woorden, 11.3)?.w === 'collega');
toets('geeft null op een woordgrens', woordOnder(woorden, 11.62) === null);
toets('geeft null in een pauze', woordOnder(woorden, 12.6) === null);

console.log('poort — regel 1: geen knip in een woord');
{
  const { segmenten, ingrepen } = poort([shot(1, 11.3, 13.2)], woorden);
  toets('schuift een start uit "collega" naar het woordbegin', segmenten[0].start === 11.05,
    `start=${segmenten[0].start}`);
  toets('schuift een eind uit "Philippe" naar het woordeind', segmenten[0].end === 13.5,
    `eind=${segmenten[0].end}`);
  toets('rapporteert beide ingrepen', ingrepen.filter((i) => i.regel === 'woordgrens').length === 2);
}
{
  const { ingrepen } = poort([shot(1, 10.75, 12.3)], woorden);
  toets('laat een correcte knip met rust', ingrepen.length === 0, JSON.stringify(ingrepen));
}

console.log('poort — regel 2: geen gedeeld bronmateriaal');
{
  const { segmenten, ingrepen } = poort([shot(1, 10.0, 12.3), shot(2, 11.0, 14.2)], woorden);
  const a = segmenten.find((s) => s.volgorde === 1)!;
  const b = segmenten.find((s) => s.volgorde === 2)!;
  toets('knipt de eerdere in tot waar de latere begint', a.end <= b.start + 0.001,
    `a.end=${a.end} b.start=${b.start}`);
  toets('rapporteert de overlap', ingrepen.some((i) => i.regel === 'overlap'));
}

console.log('poort — regel 3: geen onmogelijke segmenten');
{
  const { segmenten, ingrepen } = poort([shot(1, 10.2, 10.45)], woorden);
  toets('gooit een te kort segment weg', segmenten.length === 0);
  toets('rapporteert dat', ingrepen.some((i) => i.regel === 'ongeldig'));
}

console.log('poort is idempotent');
{
  const eerste = poort([shot(1, 11.3, 13.2), shot(2, 12.0, 14.0)], woorden);
  const tweede = poort(eerste.segmenten.map((s) => ({ ...s })), woorden);
  toets('tweede doorloop grijpt nergens meer in', tweede.ingrepen.length === 0,
    JSON.stringify(tweede.ingrepen));
}

console.log('keuring komt overeen met de poort');
{
  const ruw = [shot(1, 11.3, 13.2), shot(2, 12.0, 14.0)];
  toets('keurt ongefilterde segmenten af', !keurKnippen(ruw, woorden).goed && !keurOverlap(ruw).goed);
  const na = poort(ruw.map((s) => ({ ...s })), woorden).segmenten;
  toets('keurt de uitkomst van de poort goed', keurKnippen(na, woorden).goed && keurOverlap(na).goed,
    `${keurKnippen(na, woorden).detail} | ${keurOverlap(na).detail}`);
}

console.log('poort — regel 0: een fragment wordt nooit gehalveerd');
{
  // Een cold open die op een verzonnen punt is afgekapt: het shot loopt tot
  // 11.6 terwijl zijn fragment tot 12.3 doorloopt.
  const tease: Shot = { ...shot(1, 10.0, 11.6), ankerStart: 10.0, ankerEind: 12.3 };
  const { segmenten, ingrepen } = poort([tease], woorden);
  toets('herstelt het afgekapte eind', segmenten[0]?.end === 12.3, `eind=${segmenten[0]?.end}`);
  toets('meldt het als half fragment', ingrepen.some((i) => i.regel === 'halfFragment'));
}
{
  // Dezelfde tease naast de payoff die hetzelfde fragment gebruikt: hij kan
  // niet ingekort worden zonder de zin te halveren, dus hoort hij te vervallen.
  const tease: Shot = { ...shot(1, 10.0, 11.6), ankerStart: 10.0, ankerEind: 12.3 };
  const payoff: Shot = { ...shot(2, 10.0, 12.3), ankerStart: 10.0, ankerEind: 12.3 };
  const { segmenten } = poort([tease, payoff], woorden);
  toets('laat de duplicaat vervallen in plaats van halveren', segmenten.length === 1);
  toets('en houdt de volledige zin over',
    segmenten[0]?.start === 10.0 && segmenten[0]?.end === 12.3,
    `${segmenten[0]?.start}-${segmenten[0]?.end}`);
}

console.log('kadercontrole — een gevolgd shot past over het hele spoor');
{
  // Spreker staat aan de rechterrand: het kader kan niet verder mee, dus moet
  // de zoom omlaag tot zijn hoofd erin past.
  const seg: Shot = {
    volgorde: 1,
    start: 0,
    end: 6,
    functie: 'setup',
    focusX: 0.86,
    focusW: 0.13,
    zoom: 1.6,
    gezicht: { x: 0.86, breedte: 0.13, top: 0.2, hoogte: 0.3 },
    spoor: [
      { t: 0, x: 0.9 },
      { t: 3, x: 0.86 },
      { t: 6, x: 0.8 },
    ],
  };
  corrigeerKadrering([seg]);
  const halfBreed = 0.13 / 2;
  const past = seg.spoor!.every((punt) => {
    const u = uitsnedeVan(punt.x, seg.zoom ?? 1, seg.focusY);
    return punt.x - halfBreed >= u.x0 - 0.001 && punt.x + halfBreed <= u.x1 + 0.001;
  });
  toets('hoofd past bij elke stand van het spoor', past, `zoom=${seg.zoom}`);
}

console.log('kadering centreert op het focuspunt, ook aan de rand');
{
  // Een spreker op 0,86: het kader moet naar rechts opschuiven tot zijn hoofd
  // er helemaal in valt. Met de oude betekenis van focusX bleef het steken.
  const u = uitsnedeVan(0.86, 1, 0.5);
  toets('hoofd van 13% breed valt binnen de uitsnede',
    0.86 - 0.065 >= u.x0 - 0.001 && 0.86 + 0.065 <= u.x1 + 0.001,
    `uitsnede ${u.x0.toFixed(3)}-${u.x1.toFixed(3)}`);
  const midden = uitsnedeVan(0.5, 1, 0.5);
  toets('een spreker in het midden blijft gecentreerd',
    Math.abs((midden.x0 + midden.x1) / 2 - 0.5) < 0.001);
}

console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
process.exit(gefaald === 0 ? 0 : 1);
