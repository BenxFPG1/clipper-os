/**
 * Tests voor de retentie-editor (src/lib/roughcut/retentie.ts): de
 * risicocurve, pauzes knippen op woordgrenzen, geen ingreep in de tease, de
 * eerste-wisselregel, de grenzen (te korte delen, payoff-pauzes, geen
 * woorden) en of de poort het resultaat ongemoeid laat. Puur rekenwerk op
 * verzonnen woordlijsten, zonder video, netwerk of model.
 *
 * Draaien: npm run test:retentie
 */
import { STANDAARD_DOELEN, type EditDoelen } from '../src/lib/vault/normen';
import { keurRetentie, meetRetentie, pasRetentieToe, samenvatVoorEditAgent, wisselMomenten } from '../src/lib/roughcut/retentie';
import { poort, woordOnder } from '../src/lib/roughcut/poort';
import { keurKnippen, keurOverlap, keurFragmenten } from '../src/lib/roughcut/keuring';
import { instelling } from '../src/lib/roughcut/instellingen';
import type { Shot } from '../src/lib/roughcut';
import type { BronWoord } from '../src/lib/roughcut/woorden';

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

const doelen: EditDoelen = { ...STANDAARD_DOELEN };

/**
 * Woorden vanaf `van`: elk woord 0,3 s met 0,1 s ertussen, en op de gegeven
 * woordindexen een langere pauze erna.
 */
function spraak(van: number, aantal: number, pauzes: Record<number, number> = {}, tekst: string | string[] = 'woord'): BronWoord[] {
  const uit: BronWoord[] = [];
  let t = van;
  for (let i = 0; i < aantal; i++) {
    uit.push({ w: Array.isArray(tekst) ? tekst[i % tekst.length] : `${tekst}${i}`, s: Math.round(t * 1000) / 1000, e: Math.round((t + 0.3) * 1000) / 1000 });
    t += 0.4 + (pauzes[i] ?? 0);
  }
  return uit;
}

function shot(volgorde: number, start: number, end: number, extra: Partial<Shot> = {}): Shot {
  return { volgorde, start, end, functie: 'setup', focusX: 0.5, focusW: 0.12, ankerStart: start, ankerEind: end, ...extra };
}

const duurVan = (s: Shot[]) => s.reduce((t, x) => t + (x.end - x.start), 0);
const geenGrensInWoord = (s: Shot[], w: BronWoord[]) => s.every((x) => !woordOnder(w, x.start) && !woordOnder(w, x.end));

// ---------------------------------------------------------------------------
console.log('risicocurve');
{
  // 40 woorden vanaf 100 s, met pauzes van 0,9 s na woord 5 en 0,6 s na woord 25.
  const woorden = spraak(100, 40, { 5: 0.8, 25: 0.5 });
  const eind = woorden[woorden.length - 1].e + 0.1;
  const segs = [shot(1, 99.9, eind)];
  const m = meetRetentie(segs, { bronWoorden: woorden, doelen, ondertitels: true });
  const verwacht = Math.ceil((eind - 99.9) / instelling('RETENTIE_STAP') - 1e-9);
  toets('één punt per halve seconde', m.curve.length === verwacht, `${m.curve.length} vs ${verwacht}`);
  toets('risico tussen 0 en 1', m.curve.every((r) => r >= 0 && r <= 1));
  toets('twee pauzes boven het doel gemeten', m.pauzes === 2, String(m.pauzes));
  toets('één statisch shot: geen wissel, beeldgat = hele clip', m.eersteWissel === null && Math.abs(m.maxGatBeeld - m.duur) < 0.01, `${m.eersteWissel} ${m.maxGatBeeld}`);
  // Op het pauzemoment ligt het risico hoger dan vlak ervoor.
  const pauzeT = woorden[5].e - 99.9 + 0.4;
  const iP = Math.floor(pauzeT / 0.5);
  toets('risico piekt in de pauze', m.curve[iP] > m.curve[iP - 3], `${m.curve[iP]} vs ${m.curve[iP - 3]}`);
  toets('knelpunten benoemd', m.knelpunten.length > 0 && m.knelpunten[0].waarom.length > 0, JSON.stringify(m.knelpunten));
  toets('samenvatting voor de edit-agent is één compacte regel', !samenvatVoorEditAgent(m).includes('\n') && samenvatVoorEditAgent(m).length < 400);

  // Eerste drie seconden wegen zwaarder: exact hetzelfde signaal (elke halve
  // seconde een kaart die opkomt en wegvalt, geen woorden) geeft vroeg in de
  // clip een hoger risico dan later.
  const knipperend = Array.from({ length: 20 }, (_, k) => ({ start: k * 0.5, end: k * 0.5 + 0.4 }));
  const ml = meetRetentie([shot(1, 0, 10)], { bronWoorden: null, doelen, kaarten: knipperend });
  const factor = ml.curve[1] / ml.curve[9];
  toets('eerste seconden wegen RETENTIE_EERSTE_GEWICHT zwaarder', Math.abs(factor - instelling('RETENTIE_EERSTE_GEWICHT')) < 0.15, `${ml.curve[1]} vs ${ml.curve[9]}`);

  // Ondertitels tellen als tekst: zonder ondertitels een groot tekstgat.
  const mZonder = meetRetentie(segs, { bronWoorden: woorden, doelen, ondertitels: false });
  toets('met ondertitels is het tekstgat klein', (m.maxGatTekst ?? 99) < 1.5, String(m.maxGatTekst));
  toets('zonder ondertitels is de hele clip tekstloos', (mZonder.maxGatTekst ?? 0) > 10, String(mZonder.maxGatTekst));
}

// ---------------------------------------------------------------------------
console.log('pauzes knippen op woordgrenzen');
{
  const woorden = spraak(100, 40, { 5: 0.8, 25: 0.5 });
  const eind = woorden[woorden.length - 1].e + 0.1;
  const segs = [shot(1, 99.9, eind, { transcript_fragment: 'woord0 woord1 woord2 woord3 woord4 woord5' } as Partial<Shot>)];
  const uit = pasRetentieToe(segs, { bronWoorden: woorden, doelen, ondertitels: true });
  const pauzes = uit.ingrepen.filter((g) => g.soort === 'pauze');
  toets('beide pauzes geknipt', pauzes.length === 2, uit.ingrepen.map((g) => g.wat).join(' | '));
  const weg = duurVan(segs) - duurVan(uit.segmenten);
  const verwachtWeg = 0.9 - instelling('RETENTIE_PAUZE_REST') + (0.6 - instelling('RETENTIE_PAUZE_REST'));
  toets('precies de pauze eruit, rest-stilte blijft', Math.abs(weg - verwachtWeg) < 0.02, `${weg.toFixed(3)} vs ${verwachtWeg.toFixed(3)}`);
  toets('geen grens valt in een woord', geenGrensInWoord(uit.segmenten, woorden));
  toets('geen woord verdwijnt', woorden.every((w) => uit.segmenten.some((s) => (w.s + w.e) / 2 >= s.start && (w.s + w.e) / 2 <= s.end)));
  toets('elk deel minstens RETENTIE_MIN_DEEL', uit.segmenten.every((s) => s.end - s.start >= instelling('RETENTIE_MIN_DEEL') - 1e-6));
  toets('binnengrenzen zijn strak', uit.segmenten.slice(1).every((s) => s.strakBegin) && uit.segmenten.slice(0, -1).every((s) => s.strakEind));
  toets('volgordes uniek en oplopend', uit.segmenten.every((s, i) => i === 0 || s.volgorde > uit.segmenten[i - 1].volgorde));
  toets('alleen het eerste deel houdt het scriptfragment', uit.segmenten.slice(1).every((s) => !(s as { transcript_fragment?: string }).transcript_fragment));
  toets('vervolgdelen herhalen geen effect of sfx', uit.segmenten.slice(1).every((s) => s.beeld_effect === 'geen' && s.sfx === 'geen'));

  // De poort mag er daarna niets meer aan hoeven doen — en vooral de pauze
  // niet laten teruggroeien met ademruimte.
  const kopie = uit.segmenten.map((s) => ({ ...s }));
  const p = poort(kopie, woorden);
  const binnen = p.ingrepen.filter((g) => g.regel !== 'woordgrens');
  toets('poort: geen halfFragment/overlap/ongeldig', binnen.length === 0, JSON.stringify(binnen));
  toets('poort: strakke grenzen blijven staan', p.segmenten.every((s, i) => (i === 0 || Math.abs(s.start - uit.segmenten[i].start) < 1e-6) && (i === p.segmenten.length - 1 || Math.abs(s.end - uit.segmenten[i].end) < 1e-6)));
  // De buitenranden krijgen per ronde ademruimte (bestaand poortgedrag); de
  // binnengrenzen van de retentie mogen geen millimeter bewegen.
  const p2 = poort(p.segmenten.map((s) => ({ ...s })), woorden);
  const binnenGrenzen = (xs: Shot[]) => xs.flatMap((s, i) => [...(i > 0 ? [s.start] : []), ...(i < xs.length - 1 ? [s.end] : [])]);
  toets('poort: binnengrenzen stabiel over rondes', binnenGrenzen(p2.segmenten).every((g, i) => Math.abs(g - binnenGrenzen(p.segmenten)[i]) < 1e-6));
  toets('keuring: knippen op woordgrenzen', keurKnippen(p.segmenten, woorden).goed === true);
  toets('keuring: geen gedeeld materiaal', keurOverlap(p.segmenten).goed === true);
  toets('keuring: hele zinnen', keurFragmenten(p.segmenten).goed === true, keurFragmenten(p.segmenten).detail);
}

// ---------------------------------------------------------------------------
console.log('kaderwissels en de eerste-wisselregel');
{
  const woorden = spraak(50, 60, { 30: 0.25 });
  const eind = woorden[59].e + 0.1;
  const segs = [shot(1, 49.9, eind)];
  const uit = pasRetentieToe(segs, { bronWoorden: woorden, doelen, ondertitels: true });
  toets('eerste wissel uiterlijk op eersteKnipMaxS', uit.na.eersteWissel !== null && uit.na.eersteWissel <= doelen.eersteKnipMaxS + 1e-6, String(uit.na.eersteWissel));
  toets('max beeldgat binnen het doel (op een tiende na aan het slot)', uit.na.maxGatBeeld <= doelen.maxSecondenZonderVisueleVerandering + 0.1 + 1e-6, `${uit.voor.maxGatBeeld} → ${uit.na.maxGatBeeld}`);
  toets('wissels vallen op woordgrenzen', geenGrensInWoord(uit.segmenten, woorden));
  toets('kaderwissel knipt niets weg', Math.abs(duurVan(uit.segmenten) - duurVan(segs)) < 1e-6);
  const zooms = uit.segmenten.map((s) => s.zoom ?? 0);
  toets('afwisselend punch-in en terug', zooms.every((z, i) => i === 0 || Math.abs(z - zooms[i - 1]) >= instelling('ZOOM_NAAD_MIN_VERSCHIL') - 1e-6), zooms.join(','));
  toets('nooit wijder dan de basiszoom', zooms.every((z) => z >= Math.min(...zooms) - 1e-6 && Math.max(...zooms) - Math.min(...zooms) <= instelling('ZOOM_NAADBUMP') + 1e-6));
  toets('logregel in het afgesproken formaat', /^retentie: \d+ pauzes weg \([\d,]+ s\), \d+ kaderwissels, eerste wissel [\d,]+ s, max gat [\d,]+ s → [\d,]+ s/.test(uit.logregel), uit.logregel);
  toets('wisselmomenten tellen elke naad met kaderverschil', wisselMomenten(uit.segmenten).length === uit.segmenten.length - 1);

  // Een naad met een kaart valt al binnen het doel: dan geen extra wissel.
  const metKaart = pasRetentieToe(segs, { bronWoorden: woorden, doelen, kaarten: [{ start: 0, end: 1.6 }], ondertitels: true });
  const eersteMet = metKaart.ingrepen.find((g) => g.soort === 'eerste_wissel');
  toets('een kaart die op 1,6 s wegvalt telt als eerste wissel', !eersteMet, JSON.stringify(eersteMet));
}

// ---------------------------------------------------------------------------
console.log('geen ingreep in de tease');
{
  const woorden = [...spraak(200, 10, { 3: 0.7 }), ...spraak(210, 30, { 10: 0.7 })];
  const tease = shot(1, 199.9, woorden[9].e + 0.1, { tease: true, functie: 'hook' });
  const rest = shot(2, 209.9, woorden[39].e + 0.1, { functie: 'escalatie' });
  const uit = pasRetentieToe([tease, rest], { bronWoorden: woorden, doelen, ondertitels: true });
  const teaseDelen = uit.segmenten.filter((s) => s.volgorde >= 1 && s.volgorde < 2);
  toets('tease blijft één heel segment', teaseDelen.length === 1 && teaseDelen[0].start === tease.start && teaseDelen[0].end === tease.end);
  toets('pauze in de tease blijft staan', !uit.ingrepen.some((g) => g.soort === 'pauze' && g.volgorde === 1));
  toets('pauze ná de tease wel geknipt', uit.ingrepen.some((g) => g.soort === 'pauze' && g.volgorde === 2));
  toets('eerste wissel niet haalbaar binnen de tease wordt gemeld, niet geforceerd', uit.ingrepen.some((g) => g.soort === 'overgeslagen' && /tease/.test(g.wat)), uit.ingrepen.map((g) => g.wat).join(' | '));
}

// ---------------------------------------------------------------------------
console.log('grenzen');
{
  // Payoff: rond de onthulling (begin van het shot) is een pauze tot het
  // payoff-maximum spanning; verderop in hetzelfde shot gewoon een pauze.
  const woorden = spraak(300, 30, { 2: 0.6, 4: 1.4, 20: 0.6 });
  const payoff = shot(1, 299.9, woorden[29].e + 0.1, { functie: 'payoff' });
  const uit = pasRetentieToe([payoff], { bronWoorden: woorden, doelen, ondertitels: true });
  const pz = uit.ingrepen.filter((g) => g.soort === 'pauze');
  const wat = pz.map((g) => g.wat).join(' | ');
  toets('payoff: pauze van 0,7 s rond de onthulling blijft', !pz.some((g) => g.bron !== undefined && g.bron < woorden[3].s), wat);
  toets('payoff: pauze van 1,5 s rond de onthulling ingekort tot het payoff-maximum', pz.some((g) => g.wat.startsWith('pauze 1,5 s') && g.wat.includes(`→ ${instelling('RETENTIE_PAYOFF_PAUZE_MAX').toFixed(1).replace('.', ',')} s`)), wat);
  toets('payoff: dezelfde pauze later in het shot wél geknipt', pz.some((g) => g.wat.startsWith('pauze 0,7 s')), wat);

  // Een pauze vlak aan de rand zou een te kort deel geven: overslaan.
  const kort = spraak(400, 8, { 0: 0.8 });
  const segKort = shot(1, 399.95, kort[7].e + 0.1);
  const uitKort = pasRetentieToe([segKort], { bronWoorden: kort, doelen, ondertitels: true });
  toets('pauze aan de rand: geen deel korter dan het minimum', uitKort.segmenten.every((s) => s.end - s.start >= instelling('RETENTIE_MIN_DEEL') - 1e-6));
  toets('en dat wordt gemeld', uitKort.ingrepen.some((g) => g.soort === 'overgeslagen' && /korter/.test(g.wat)));

  // Zonder woordtijden: niets doen, en de keuring zegt "niet te toetsen".
  const zonder = pasRetentieToe([shot(1, 0, 20)], { bronWoorden: null, doelen });
  toets('zonder woorden: segmenten ongewijzigd', zonder.segmenten.length === 1 && zonder.segmenten[0].end === 20);
  toets('zonder woorden: keuring niet getoetst', keurRetentie(zonder.na, doelen).goed === null);

  // Overlappende woordtijden bieden geen grens: daar wordt niet gewisseld.
  const overlap: BronWoord[] = Array.from({ length: 40 }, (_, i) => ({ w: `w${i}`, s: 500 + i * 0.3, e: 500 + i * 0.3 + 0.35 }));
  const uitOverlap = pasRetentieToe([shot(1, 500, overlap[39].e)], { bronWoorden: overlap, doelen });
  toets('overlappende woorden: geen wissel midden in een woord', geenGrensInWoord(uitOverlap.segmenten, overlap) && uitOverlap.segmenten.length === 1);
}

// ---------------------------------------------------------------------------
console.log('volgnummers');
{
  // Een lang shot met veel pauzes naast een sprekerswissel-helft (2,5): de
  // delen mogen daar nooit mee botsen.
  const pauzes: Record<number, number> = {};
  for (let i = 3; i < 150; i += 4) pauzes[i] = 0.7;
  const woorden = spraak(700, 150, pauzes);
  const lang = shot(2, 699.9, woorden[149].e + 0.1);
  const helft = shot(2.5, woorden[149].e + 5, woorden[149].e + 9);
  const uit = pasRetentieToe([lang, helft], { bronWoorden: woorden, doelen });
  const nummers = uit.segmenten.map((s) => s.volgorde);
  toets(`veel delen (${nummers.length}), allemaal uniek`, new Set(nummers).size === nummers.length && nummers.length > 20);
  toets('delen blijven onder de sprekerswissel-helft', uit.segmenten.filter((s) => s.start < 800 && s.start < helft.start).every((s) => s.volgorde < 2.5));
}

// ---------------------------------------------------------------------------
console.log('keuring en re-hook');
{
  // Een aanloop die blijft herhalen ("het geld was eigenlijk gewoon weg"):
  // precies het soort stuk vóór de payoff waar een re-hook voor is.
  const aanloop = ['het', 'geld', 'was', 'eigenlijk', 'gewoon', 'weg', 'zeg', 'maar'];
  const woorden = [...spraak(600, 60, { 8: 0.8, 30: 0.9 }, aanloop), ...spraak(630, 12)];
  const setup = shot(1, 599.9, woorden[59].e + 0.1, { functie: 'setup' });
  const payoff = shot(2, 629.9, woorden[71].e + 0.1, { functie: 'payoff' });
  const hookTot = 2.4;
  const uit = pasRetentieToe([setup, payoff], {
    bronWoorden: woorden,
    doelen,
    kaarten: [{ start: 0, end: hookTot }],
    ondertitels: true,
    hookTot,
    rehookRegels: ['wacht op het bedrag'],
  });
  const voorOordeel = keurRetentie(uit.voor, doelen);
  const naOordeel = keurRetentie(uit.na, doelen);
  toets('vóór de ingrepen: review nodig', voorOordeel.goed === false, voorOordeel.detail);
  toets('na de ingrepen: binnen de doelen', naOordeel.goed === true, naOordeel.detail);
  toets('re-hook geplaatst tussen hook en payoff', uit.rehook !== null && uit.rehook.start >= hookTot + 1 && uit.rehook.end <= duurVan(uit.segmenten.filter((s) => s.functie !== 'payoff')), JSON.stringify(uit.rehook));
  toets('re-hook overlapt de hookkaart niet', uit.rehook !== null && uit.rehook.start >= hookTot);
  const zonderRegel = pasRetentieToe([setup, payoff], { bronWoorden: woorden, doelen, kaarten: [{ start: 0, end: hookTot }], hookTot });
  toets('zonder regel geen re-hook', zonderRegel.rehook === null);
}

console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
if (gefaald > 0) process.exit(1);
