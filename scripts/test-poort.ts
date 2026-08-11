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
import { basisZoom, type Shot } from '../src/lib/roughcut';
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
  // Het hele woord komt mee, plus een vleugje ademruimte — maar het buurwoord
  // blijft erbuiten.
  toets('neemt "collega" helemaal mee', segmenten[0].start <= 11.05 && segmenten[0].start > 11.0,
    `start=${segmenten[0].start}`);
  toets('neemt "Philippe" helemaal mee', segmenten[0].end >= 13.5 && segmenten[0].end < 13.55,
    `eind=${segmenten[0].end}`);
  toets('rapporteert beide ingrepen', ingrepen.filter((i) => i.regel === 'woordgrens').length === 2);
}
{
  const { ingrepen } = poort([shot(1, 10.75, 12.3)], woorden);
  toets('laat een correcte knip met rust', ingrepen.length === 0, JSON.stringify(ingrepen));
}
{
  // De bug die "geen vreemde aanloop" keer op keer liet falen: een correctie
  // verzette start/eind, maar liet ankerStart/ankerEind op de oude waarde
  // staan — waarna regel 0 (halfFragment) de grens de eerstvolgende ronde
  // straal terugtrok naar dat oude, inmiddels foute anker. Hier gesimuleerd:
  // een stale ankerStart die nog op de oude (foute) waarde staat vóórdat
  // regel 1 de knip naar de woordgrens verzet — het anker moet meeverzetten,
  // anders vecht een volgende poort()-ronde het weer terug.
  const s = shot(1, 11.3, 12.3);
  (s as { ankerStart?: number }).ankerStart = 11.3;
  const { segmenten } = poort([s], woorden);
  // Regel 1b (ademruimte) mag de grens ná regel 1 nog een fractie verzetten
  // zonder het anker te synchroniseren — dat is bewust onaangeroerd gelaten
  // omdat de marge (max 0,12s) ruim onder de 0,15s zit waarop regel 0
  // ingrijpt. De echte garantie is dus niet "exact gelijk", maar "blijft
  // binnen de tolerantie van regel 0" — anders vecht de eerstvolgende
  // poort()-ronde het alsnog terug.
  toets(
    'ankerStart blijft binnen regel 0s tolerantie van de woordgrens-correctie',
    Math.abs((segmenten[0].ankerStart ?? 0) - segmenten[0].start) < 0.15,
    `ankerStart=${segmenten[0].ankerStart} start=${segmenten[0].start}`,
  );
}

console.log('poort — regel 1b: ademruimte rond de knip');
{
  // Knip pal op de grenzen van "mijn ... zat": er hoort lucht omheen te komen,
  // maar nooit zoveel dat het buurwoord meekomt.
  const { segmenten } = poort([shot(1, 10.75, 12.3)], woorden);
  const s0 = segmenten[0];
  toets('begin schuift naar buiten', s0.start < 10.75, `start=${s0.start.toFixed(3)}`);
  toets('maar niet tot in "dat"', s0.start >= 10.7, `start=${s0.start.toFixed(3)}`);
  toets('eind schuift naar buiten', s0.end > 12.3, `eind=${s0.end.toFixed(3)}`);
  toets('maar niet tot in "Philippe"', s0.end <= 12.9, `eind=${s0.end.toFixed(3)}`);
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
  toets('herstelt het afgekapte eind', (segmenten[0]?.end ?? 0) >= 12.3, `eind=${segmenten[0]?.end}`);
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
    (segmenten[0]?.start ?? 1) <= 10.0 && (segmenten[0]?.end ?? 0) >= 12.3,
    `${segmenten[0]?.start}-${segmenten[0]?.end}`);
}

console.log('poort — doorlopende spraak krijgt uitklinkruimte');
{
  // "wou" eindigt precies waar "dat" begint: geen stilte. Dan hoort de knip
  // door te lopen en zacht te zijn.
  const { segmenten: s2 } = poort([shot(2, 10.0, 11.0)], woorden);
  toets('grens blijft op het woord staan', s2[0].end <= 11.05, `eind=${s2[0].end}`);
  toets('en krijgt een zachte overgang', s2[0].zachtEind === true);
}

console.log('zoom maakt centreren mogelijk');
{
  const zijkant: Shot = { ...shot(1, 0, 6), focusX: 0.9, focusW: 0.12,
    gezicht: { x: 0.9, breedte: 0.12, top: 0.25, hoogte: 0.3 } };
  const z = basisZoom(zijkant);
  const u = uitsnedeVan(0.9, z, 0.5);
  toets('kader kan centreren op een spreker aan de rand',
    Math.abs((u.x0 + u.x1) / 2 - 0.9) < 0.02, `zoom=${z.toFixed(2)} midden=${((u.x0+u.x1)/2).toFixed(3)}`);
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

console.log('poort staat tussen elke correctie en de render');
{
  // Een correctielus die een grens verzet mag niet om de regels heen: de
  // poort hoort dat bij de volgende doorloop recht te trekken.
  const na: Shot = { ...shot(1, 10.0, 12.3), ankerStart: 10.0, ankerEind: 12.3 };
  const eerste = poort([na], woorden).segmenten[0];
  // Correctielus verzet de start naar binnen (zoals de aanloopcorrectie deed).
  eerste.start = 10.3;
  const tweede = poort([eerste], woorden).segmenten[0];
  toets('herstelt een grens die na de eerste doorloop verzet is',
    tweede.start <= 10.05, `start=${tweede.start}`);
}

console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
process.exit(gefaald === 0 ? 0 : 1);
