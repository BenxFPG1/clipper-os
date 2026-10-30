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
import { poort, verzetGrens, woordOnder } from '../src/lib/roughcut/poort';
import { keurKnippen, keurOverlap, keurScriptCompleet, keuringStatus } from '../src/lib/roughcut/keuring';
import { corrigeerKadrering, uitsnedeVan } from '../src/lib/roughcut/kadercontrole';
import { basisZoom, type Shot } from '../src/lib/roughcut';
import { eindNaReactie, vindFragment, type BronWoord } from '../src/lib/roughcut/woorden';
import { verwijderDodeLucht } from '../src/lib/roughcut/snap';

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
{
  // verzetGrens is de enige juiste manier om een grens te verzetten: het
  // anker gaat altijd mee, zodat regel 0 een bewuste correctie nooit meer
  // terugvecht (de "verweesde anker"-klasse bug).
  const s = shot(1, 10.0, 12.3);
  (s as { ankerStart?: number; ankerEind?: number }).ankerStart = 10.0;
  (s as { ankerStart?: number; ankerEind?: number }).ankerEind = 12.3;
  verzetGrens(s, { start: 10.75 });
  toets('verzetGrens synchroniseert ankerStart', s.ankerStart === 10.75 && s.start === 10.75);
  verzetGrens(s, { end: 11.9 });
  toets('verzetGrens synchroniseert ankerEind', s.ankerEind === 11.9 && s.end === 11.9);
  // En de poort accepteert het resultaat zonder terug te trekken.
  const { ingrepen } = poort([s], null);
  toets('poort vecht een verzetGrens-correctie niet terug', !ingrepen.some((i) => i.regel === 'halfFragment'),
    JSON.stringify(ingrepen));
}

console.log('poort — regel 1: een woord van de buurzin blijft erbuiten');
{
  // PLATINA clip 3, echte woordtijden. Shot 4 (+ deel 4.01) eindigt na
  // "politiek.", shot 5 begint bij "En". De geplande grenzen vielen net in
  // het verkeerde woord: 4.01 in "En", 5 in "politiek.".
  const bron: BronWoord[] = [
    ['Maar', 293.44, 293.56], ['het', 293.56, 293.72], ['is', 293.72, 293.86], ['geen', 293.86, 294.1], ['tweede', 294.1, 294.5], ['goud.', 294.5, 294.74],
    ['Goud', 295.0, 295.26], ['beweegt', 295.26, 295.74], ['of', 295.74, 296.02], ['vertrouwen', 296.02, 296.7], ['en', 296.7, 296.88], ['monetaire', 296.88, 297.28], ['politiek.', 297.28, 297.86],
    ['En', 297.86, 298.3], ['Platina', 298.3, 298.74], ['beweegt', 298.74, 299.12], ['ook', 299.12, 299.44], ['daarop,', 299.44, 300.02], ['maar', 300.14, 300.36],
  ].map(([w, s, e]) => ({ w: w as string, s: s as number, e: e as number }));
  const s4 = { ...shot(4, 293.3, 295.0), transcript_fragment: 'Maar het is geen tweede goud. Goud beweegt of vertrouwen en monetaire politiek.' } as Shot;
  const s401 = shot(4.01, 295.0, 297.94);
  const s5 = { ...shot(5, 297.82, 300.1), transcript_fragment: 'En Platina beweegt ook daarop, maar ook op autoverkopen.' } as Shot;
  const { segmenten, ingrepen } = poort([s4, s401, s5], bron);
  const d401 = segmenten.find((x) => x.volgorde === 4.01);
  const d5 = segmenten.find((x) => x.volgorde === 5);
  toets('deel 4.01 eindigt vóór "En" (dat hoort bij shot 5)', Boolean(d401 && d401.end <= 297.87 && d401.end >= 297.84), JSON.stringify({ d401, ingrepen }));
  toets('shot 5 begint ná "politiek." (dat hoort bij de vorige zin)', Boolean(d5 && d5.start >= 297.83 && d5.start <= 297.87), JSON.stringify({ d5, ingrepen }));
  toets('geen shot valt weg (de zin over goud blijft)', segmenten.length === 3 && !ingrepen.some((i) => i.regel === 'overlap'), JSON.stringify(ingrepen));
}
{
  // PLATINA clip 2: shot 3 "Meer dan 70 procent…" begon in "geconcentreerd."
  // (het einde van de vorige zin) en kreeg dat woord erbij.
  const bron: BronWoord[] = [
    ['aanbod', 130.66, 131.02], ['extreem', 131.02, 131.64], ['geconcentreerd.', 131.64, 132.3], ['Meer', 132.3, 132.96], ['dan', 132.96, 133.1], ['70', 133.1, 133.5],
  ].map(([w, s, e]) => ({ w: w as string, s: s as number, e: e as number }));
  const s3 = { ...shot(3, 132.26, 133.5), transcript_fragment: 'Meer dan 70 procent van alle platina ter wereld komt uit Zuid-Afrika.' } as Shot;
  const { segmenten } = poort([s3], bron);
  toets('"geconcentreerd." blijft buiten shot 3', segmenten[0].start >= 132.25, `start=${segmenten[0].start}`);
  // En het eerste woord van het fragment zelf komt wél helemaal mee.
  const s3b = { ...shot(3, 132.5, 133.5), transcript_fragment: 'Meer dan 70 procent' } as Shot;
  toets('valt de knip in het eerste woord van het fragment, dan komt dat mee', poort([s3b], bron).segmenten[0].start <= 132.3, `start=${poort([s3b], bron).segmenten[0].start}`);
}

{
  // Whisper splitst samengestelde woorden: "Zuid" + "-Afrika.". De knip viel
  // in "-Afrika." en de test-render eindigde op "…komt uit Zuid.".
  const bron: BronWoord[] = [
    ['komt', 136.1, 136.3], ['uit', 136.3, 136.42], ['Zuid', 136.42, 136.7], ['-Afrika.', 136.7, 137.14], ['Ten', 137.9, 138.1],
  ].map(([w, s, e]) => ({ w: w as string, s: s as number, e: e as number }));
  const sz = { ...shot(3, 133, 136.9), transcript_fragment: 'Meer dan 70 procent van alle platina ter wereld komt uit Zuid-Afrika.' } as Shot;
  const { segmenten } = poort([sz], bron);
  toets('gesplitst samengesteld woord blijft heel ("Zuid-Afrika.")', segmenten[0].end >= 137.14, `eind=${segmenten[0].end}`);
  const tr: BronWoord[] = [['circa', 171, 171.3], ['297.000', 171.3, 171.9], ['Troy', 171.9, 172.1], ['-ounce.', 172.1, 172.5]].map(([w, s, e]) => ({ w: w as string, s: s as number, e: e as number }));
  const st = { ...shot(4, 165, 172.2), transcript_fragment: 'een tekort van circa 297.000 Troi-ounce.' } as Shot;
  toets('…en "Troy-ounce." ook', poort([st], tr).segmenten[0].end >= 172.5, `eind=${poort([st], tr).segmenten[0].end}`);
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
  toets('keurt ongefilterde segmenten af', keurKnippen(ruw, woorden).goed === false && keurOverlap(ruw).goed === false);
  const na = poort(ruw.map((s) => ({ ...s })), woorden).segmenten;
  toets('keurt de uitkomst van de poort goed', keurKnippen(na, woorden).goed === true && keurOverlap(na).goed === true,
    `${keurKnippen(na, woorden).detail} | ${keurOverlap(na).detail}`);
}

console.log('keuring — niet te toetsen is geen goedkeuring');
{
  const zonder = keurKnippen([shot(1, 10.75, 12.3)], null);
  toets('zonder brontranscriptie is de regel null, niet true', zonder.goed === null, String(zonder.goed));
  toets('status van alleen null-regels is niet_getoetst', keuringStatus([zonder]) === 'niet_getoetst');
  toets('één echte fout is review nodig',
    keuringStatus([zonder, { naam: 'x', goed: false, detail: '' }]) === 'review_nodig');
  toets('null naast een echte goed is goed',
    keuringStatus([zonder, { naam: 'x', goed: true, detail: '' }]) === 'goed');
}

console.log('poort — regel 2: de tease (cold open) blijft staan');
{
  // De worker markeert een korte cold open die de payoff vooruit laat horen
  // als tease. Die deelt per definitie bronmateriaal met de payoff; de poort
  // liet hem daardoor áltijd vervallen (inkorten kon niet: zelfde beginpunt),
  // of — zonder woordankers — verloor de payoff zijn eerste zin.
  const tease: Shot = { ...shot(1, 10.0, 12.3), functie: 'hook', tease: true, ankerStart: 10.0, ankerEind: 12.3 };
  const payoff: Shot = { ...shot(2, 10.0, 14.2), functie: 'payoff', ankerStart: 10.0, ankerEind: 14.2 };
  const { segmenten, ingrepen } = poort([tease, payoff], woorden);
  toets('beide segmenten blijven bestaan', segmenten.length === 2, `${segmenten.length} over`);
  const p = segmenten.find((s) => s.volgorde === 2);
  toets('de payoff verliest zijn eerste zin niet', (p?.start ?? 99) <= 10.0 + 0.001, `payoff start=${p?.start}`);
  toets('de tease is heel gebleven', (segmenten[0].end ?? 0) >= 12.3, `tease eind=${segmenten[0].end}`);
  toets('en de poort meldt het als bewuste tease', ingrepen.some((i) => i.regel === 'tease'));
  toets('de keuring accepteert het gedeelde materiaal ook', keurOverlap(segmenten).goed === true, keurOverlap(segmenten).detail);
}
{
  // Zonder woordankers (geen brontranscriptie) mag de payoff evenmin worden
  // aangesneden.
  const tease: Shot = { ...shot(1, 10.0, 12.3), functie: 'hook', tease: true };
  const payoff: Shot = { ...shot(2, 10.0, 14.2), functie: 'payoff' };
  const { segmenten } = poort([tease, payoff], null);
  const p = segmenten.find((s) => s.volgorde === 2);
  toets('zonder ankers: payoff begint nog steeds op zijn eigen begin', p?.start === 10.0, `start=${p?.start}`);
}
{
  // Een "tease" die te lang is, is gewoon een duplicaat en volgt de gewone regel.
  const lang: Shot = { ...shot(1, 10.0, 16.0), tease: true, ankerStart: 10.0, ankerEind: 16.0 };
  const payoff: Shot = { ...shot(2, 10.0, 16.0), ankerStart: 10.0, ankerEind: 16.0 };
  const { segmenten } = poort([lang, payoff], woorden);
  toets('een lange tease geldt niet als tease en vervalt als duplicaat', segmenten.length === 1);
}

{
  // Trainingsronde 11: de opening (284,3–285,5 "Vier jaar op rij meer") lag in
  // de bron ná een later shot (281,3–284,5, met ademruimte tot over "Vier").
  // De poort kon alleen de eerdere inkorten en liet de openingszin vervallen.
  const opening: Shot = { ...shot(1, 284.3, 285.54), functie: 'hook', ankerStart: 284.3, ankerEind: 285.54 };
  const later: Shot = { ...shot(2.02, 281.28, 284.5), ankerStart: 281.28, ankerEind: 284.05 };
  const { segmenten, ingrepen } = poort([opening, later], null);
  const o = segmenten.find((s) => s.volgorde === 1);
  const l = segmenten.find((s) => s.volgorde === 2.02);
  toets('de opening blijft staan als hij in de staart van een later shot begint', o?.start === 284.3 && o?.end === 285.54, JSON.stringify(ingrepen));
  toets('het latere shot levert zijn staart in', (l?.end ?? 0) <= 284.3 + 1e-9 && (l?.end ?? 0) >= 284.05 - 1e-9, `eind=${l?.end}`);
  toets('geen overlap meer volgens de keuring', keurOverlap(segmenten).goed === true, keurOverlap(segmenten).detail);
  const mist = keurScriptCompleet([1, 2, 3], [{ volgorde: 1.002 }, { volgorde: 2.02 }, { volgorde: 3 }]);
  toets('script compleet: deelstukken tellen voor hun shot', mist.goed === true, mist.detail);
  const zonderOpening = keurScriptCompleet([1, 2, 3], [{ volgorde: 2 }, { volgorde: 2.02 }, { volgorde: 3 }]);
  toets('script compleet: ontbrekende opening is rood en wordt zo genoemd', zonderOpening.goed === false && /opent niet zoals gepland/.test(zonderOpening.detail), zonderOpening.detail);
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

console.log('dode lucht — delen van één shot rekt de poort niet terug');
{
  const hele: Shot = { ...shot(1, 10, 22), functie: 'hook', ankerStart: 10, ankerEind: 22 } as Shot;
  const delen = verwijderDodeLucht([hele, { ...shot(2, 30, 34), functie: 'payoff' } as Shot], [{ start: 14, end: 16 }, { start: 18, end: 20 }]);
  toets('plannummers blijven staan', delen.map((d) => Math.floor(d.volgorde as number)).join() === '1,1,1,2', delen.map((d) => d.volgorde).join());
  toets('alleen de buitenkant houdt een anker', delen[0].ankerEind === undefined && delen[1].ankerStart === undefined && delen[1].ankerEind === undefined && delen[2].ankerStart === undefined && delen[2].ankerEind === 22);
  const p = poort(delen as Shot[], null);
  toets('poort laat de delen staan', p.segmenten.length === 4 && !p.ingrepen.some((g) => g.regel === 'halfFragment' || g.regel === 'overlap'), JSON.stringify(p.ingrepen));
  toets('script compleet ziet shot 1 en 2', keurScriptCompleet([1, 2], p.segmenten).goed === true);
}

console.log('reactie — de zin na de punchline blijft erbij');
{
  const r = (w: string, s: number): BronWoord => ({ w, s, e: s + 0.3 });
  const na = [r('Je', 51), r('bent', 51.4), r('dom', 51.8), r('man.', 52.2), r('Hey', 53), r('die', 53.4)];
  toets('eerste hele zin', Math.abs(eindNaReactie(na, 50.5, 59) - 52.8) < 0.01);
  toets('alleen gelach loopt door', eindNaReactie([], 50, 59) === 52.5);
  toets('geen zinseinde: niets erbij', eindNaReactie(na.slice(0, 3), 50.5, 59) === 50.5);
  const bron = 'mag ze dat ze is geen dief vind ik heel mooi gezegd broeder stel die nog een keer geen'.split(' ').map((w, i) => r(w, i));
  const a = vindFragment(bron, 'mag ze dat ze is toch geen dief zeker', 0);
  toets('staart springt niet naar een woord uit een latere zin', a?.end != null && a.end < 7, JSON.stringify(a));
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
