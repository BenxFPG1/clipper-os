/**
 * Tests voor de actieve-sprekerdetectie (src/lib/roughcut/sprekers.ts): de
 * beslisregel op een gestubde mondmeting (wie praat, hysterese, kauwen
 * zonder geluid, camerawissels, tweeshot), het toepassen op een shot (knip
 * op een woordgrens of de bronknip, anders een snelle pan) en de meting in
 * gezichten.py op een synthetische bron met een camerawissel.
 *
 * Draaien: npm run test:sprekers
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { pythonMetOpenCV } from '../src/lib/python';
import type { Shot } from '../src/lib/roughcut';
import { actieveSprekers, herstelSprekerKader, meetSprekers, pasSprekersToe, tweeshotPast, voegDubbeleSamen, type SprekerMeting, type SprekerPersoon } from '../src/lib/roughcut/sprekers';
import { keurGezichtDetail, type GezichtPuntMeting } from '../src/lib/roughcut/keuring';
import { besluitScherpBegin, pasScherpBeginToe, scherpteMeterVia, type ScherpteMeting } from '../src/lib/roughcut/scherpbegin';
import { instelling } from '../src/lib/roughcut/instellingen';
import { poort } from '../src/lib/roughcut/poort';
import { herhaaldInBron, keurKnippen } from '../src/lib/roughcut/keuring';
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

const STAP = 0.1;
/** Een persoon met een mondbeweging per tijdstip (functie van t). */
function persoon(id: number, scene: number, x: number, van: number, tot: number, mond: (t: number) => number): SprekerPersoon {
  const monsters: [number, number, number | null][] = [];
  for (let t = van; t < tot - 1e-6; t += STAP) monsters.push([Math.round(t * 1000) / 1000, x, Math.round(mond(t) * 1000) / 1000]);
  return { id, scene, x, breedte: 0.07, oog: 0.35, top: 0.25, hoogte: 0.16, n: monsters.length, monsters };
}
const spraakVan = (van: number, tot: number, actief: (t: number) => boolean) => {
  const uit: number[] = [];
  for (let t = van; t < tot - 1e-6; t += STAP) uit.push(actief(t) ? 0.8 : 0.02);
  return uit;
};
// Lettergrepen: de mond van wie praat gaat op en neer (4 Hz), met ruis.
const praat = (t: number) => 6 + 5 * Math.abs(Math.sin(2 * Math.PI * 4 * t));
const rustig = (t: number) => 1 + 0.5 * Math.abs(Math.sin(7 * t));
const shot = (start: number, end: number): Shot => ({ volgorde: 1, start, end, functie: 'setup', focusX: 0.5, focusW: 0.1 });

async function main() {
  console.log('wie praat er (gestubde mondmeting)');
  {
    // A (x 0,3) praat 0–4,5 s, B (x 0,7) praat 5–10 s. B kauwt in de stilte
    // 4,5–5 s, en heeft om 2 s een losse mondbeweging van 0,3 s.
    const spraak = spraakVan(0, 10, (t) => t < 4.5 || t >= 5);
    const A = persoon(0, 0, 0.3, 0, 10, (t) => (t < 4.5 ? praat(t) : rustig(t)));
    const B = persoon(1, 0, 0.7, 0, 10, (t) => (t >= 5 ? praat(t) : t >= 4.5 ? 9 : t >= 2 && t < 2.3 ? 9 : rustig(t)));
    const m: SprekerMeting = { van: 0, tot: 10, stap: STAP, personen: [A, B], knippen: [] };
    const st = actieveSprekers(m, spraak);
    console.log(`    ${st.map((s) => `${s.van.toFixed(1)}-${s.tot.toFixed(1)}:${s.persoon?.x}`).join(' ')}`);
    toets('eerst A, dan B', st.length === 2 && st[0].persoon?.id === 0 && st[1].persoon?.id === 1, JSON.stringify(st.map((s) => [s.van, s.tot, s.persoon?.id])));
    toets('wissel rond het echte moment (4,5–5,5 s)', st[1]?.van >= 4.5 && st[1]?.van <= 5.5, String(st[1]?.van));
    toets('losse mondbeweging van B om 2 s is geen wissel (hysterese)', !st.some((s) => s.persoon?.id === 1 && s.van < 4));
    toets('geen wissel op een bronknip', st.every((s) => !s.opKnip));

    // Kauwen zonder geluid: B beweegt de hele tijd heftig, maar alleen A
    // praat gelijk op met het geluid.
    const Bkauwt = persoon(1, 0, 0.7, 0, 10, (t) => 8 + 3 * Math.abs(Math.sin(2 * Math.PI * 1.3 * t)));
    const spraak2 = spraakVan(0, 10, (t) => Math.abs(Math.sin(2 * Math.PI * 4 * t)) > 0.3);
    const Aecht = persoon(0, 0, 0.3, 0, 10, (t) => (Math.abs(Math.sin(2 * Math.PI * 4 * t)) > 0.3 ? 10 : 1));
    const k = actieveSprekers({ van: 0, tot: 10, stap: STAP, personen: [Aecht, Bkauwt], knippen: [] }, spraak2);
    toets('kauwen zonder geluid wint niet van de spreker', k.length === 1 && k[0].persoon?.id === 0, JSON.stringify(k.map((s) => [s.van, s.tot, s.persoon?.id])));
  }

  console.log('camerawissels');
  {
    // Standpunt 0 (0–3 s): A en B, A praat. Knip op 3 s. Standpunt 1: alleen C.
    const A = persoon(0, 0, 0.3, 0, 3, praat);
    const B = persoon(1, 0, 0.7, 0, 3, rustig);
    const C = persoon(2, 1, 0.55, 3, 6, praat);
    const st = actieveSprekers({ van: 0, tot: 6, stap: STAP, personen: [A, B, C], knippen: [3] }, spraakVan(0, 6, () => true));
    toets('een stuk per standpunt', st.length === 2 && st[0].persoon?.id === 0 && st[1].persoon?.id === 2);
    toets('tweede stuk begint op de bronknip', st[1]?.opKnip === true && st[1]?.van === 3);
    const seg = shot(0.5, 5.5);
    const r = pasSprekersToe(seg, st, null);
    toets('shot gesplitst op de bronknip', r.delen.length === 2 && r.delen[0].end === 3 && r.delen[1].start === 3, r.delen.map((d) => `${d.start}-${d.end}`).join(' '));
    toets('elk deel op zijn eigen spreker', r.delen[0].focusX === 0.3 && r.delen[1].focusX === 0.55);
    toets('wissel gelogd als bronknip', r.wissels.length === 1 && r.wissels[0].soort === 'bronknip');
    toets('delen gemarkeerd (oude meting blijft eraf)', r.delen.every((d) => d.sprekerBepaald === true));
    toets('gezichtsvak van de spreker, niet van de ander', r.delen[0].gezicht?.x === 0.3 && r.delen[0].gezicht?.hoogte === 0.16);
    toets('tweede deel erft geen effect of sfx', r.delen[1].beeld_effect === 'geen' && r.delen[1].sfx === 'geen');

    // Na de knip een graphic zonder persoon: dat deel erft het sprekerkader niet.
    const st2 = actieveSprekers({ van: 0, tot: 6, stap: STAP, personen: [A, B], knippen: [3] }, spraakVan(0, 6, () => true));
    const seg2 = shot(0.5, 5.5);
    const r2 = pasSprekersToe(seg2, st2, null);
    toets('deel zonder persoon: geen sprekerkader, oorspronkelijke focus', r2.delen.length === 2 && r2.delen[0].sprekerBepaald === true && !r2.delen[1].sprekerBepaald && r2.delen[1].focusX === 0.5, JSON.stringify(r2.delen.map((d) => [d.start, d.focusX, d.sprekerBepaald])));
    const r3 = pasSprekersToe({ ...shot(0.5, 5.5), volgorde: 2.5 }, st, null, { volgendeVolgorde: 3 });
    toets('volgnummers blijven vóór het volgende shot', r3.delen.every((d) => d.volgorde >= 2.5 && d.volgorde < 3) && r3.delen.every((d, i) => i === 0 || d.volgorde > r3.delen[i - 1].volgorde), r3.delen.map((d) => d.volgorde).join(','));
  }

  console.log('zelfherstel spreker');
  {
    // Kader op 0,30, de spreker staat op 0,62: de keuring ziet het hoofd
    // buiten beeld; het herstel zet het kader op het gezicht.
    const seg: Shot = { ...shot(10, 16), focusX: 0.3, focusW: 0.08, gezicht: { x: 0.3, breedte: 0.08, top: 0.3, hoogte: 0.2 } };
    const vak = { x: 0.62, breedte: 0.09, top: 0.28, hoogte: 0.22 };
    const meter = async (t: number[]): Promise<GezichtPuntMeting[]> => t.map(() => ({ ...vak, gezichten: [vak] }));
    const voor = await keurGezichtDetail({ segmenten: [seg], sprekerMeter: meter });
    toets('keuring ziet het hoofd naast het kader, met structuur', voor.regel.goed === false && voor.fouten.length > 0 && voor.fouten[0].gezicht.x === 0.62, voor.regel.detail);
    const { log, shots } = herstelSprekerKader([seg], voor.fouten);
    console.log(`    ${log[0]}`);
    toets('kader naar het gemeten gezicht', seg.focusX === 0.62 && shots.length === 1 && /zelfherstel spreker: shot 1 → kader naar gezicht op 0\.62/.test(log[0] ?? ''));
    toets('zoom zodat het hele hoofd erin past (≤ 60% van de uitsnede)', 0.09 / ((1080 / (1920 * (16 / 9))) / (seg.zoom ?? 1)) <= 0.6 + 1e-6, String(seg.zoom));
    const na = await keurGezichtDetail({ segmenten: [seg], sprekerMeter: meter });
    toets('daarna: actieve spreker in beeld', na.regel.goed === true, na.regel.detail);
    const klein = herstelSprekerKader([{ ...shot(0, 5) }], [{ volgorde: 1, t: 1, soort: 'uit_midden', waarde: 0.15, gezicht: vak }]);
    toets('kleine afwijking (15% uit het midden): niet aanpassen', klein.log.length === 0);
    // Op een spoor: alleen het stuk rond het foute moment.
    const metSpoor: Shot = { ...shot(0, 6), spoor: [{ t: 0, x: 0.4 }, { t: 2, x: 0.4 }, { t: 4, x: 0.4 }, { t: 6, x: 0.4 }] };
    herstelSprekerKader([metSpoor], [{ volgorde: 1, t: 4.1, soort: 'niet_in_beeld', waarde: 0.4, gezicht: vak }]);
    toets('spoor: alleen rond het foute moment naar het gezicht', metSpoor.spoor!.find((p) => p.t === 0)!.x === 0.4 && metSpoor.spoor!.find((p) => p.t === 4)!.x === 0.62, JSON.stringify(metSpoor.spoor));
  }

  console.log('tweeshot alleen als het werkt in 9:16');
  {
    toets('dicht bij elkaar, grote gezichten: tweeshot', tweeshotPast({ x: 0.45, breedte: 0.07 }, { x: 0.58, breedte: 0.07 }));
    toets('kleine gezichten (3%): geen tweeshot (twee postzegels)', !tweeshotPast({ x: 0.45, breedte: 0.025 }, { x: 0.62, breedte: 0.025 }));
    toets('ver uit elkaar: geen tweeshot', !tweeshotPast({ x: 0.2, breedte: 0.08 }, { x: 0.8, breedte: 0.08 }));
  }

  console.log('scherp gezicht wint bij gelijke kans');
  {
    const spraak = spraakVan(0, 6, () => true);
    const zelfde = (t: number) => praat(t);
    const metScherpte = (p: SprekerPersoon, sc: number): SprekerPersoon => ({ ...p, monsters: p.monsters.map((m) => [m[0], m[1], m[2], sc] as [number, number, number | null, number]) });
    const wazig = metScherpte(persoon(0, 0, 0.3, 0, 6, zelfde), 8);
    const scherp = metScherpte(persoon(1, 0, 0.7, 0, 6, zelfde), 70);
    const st = actieveSprekers({ van: 0, tot: 6, stap: STAP, personen: [wazig, scherp], knippen: [] }, spraak);
    toets('twee even sprekende gezichten: het scherpe wordt gekozen', st[0]?.persoon?.id === 1, JSON.stringify(st.map((x) => x.persoon?.id)));
    const duidelijk = metScherpte(persoon(0, 0, 0.3, 0, 6, praat), 8);
    const stil = metScherpte(persoon(1, 0, 0.7, 0, 6, rustig), 70);
    const st2 = actieveSprekers({ van: 0, tot: 6, stap: STAP, personen: [duidelijk, stil], knippen: [] }, spraak);
    toets('maar een duidelijke (wazige) spreker blijft winnen van een scherpe zwijger', st2[0]?.persoon?.id === 0);
  }

  console.log('scherp begin');
  {
    const eerste: Shot = { ...shot(100, 106), focusX: 0.3 };
    const tijden = [100.04, 100.14, 100.24, 100.34, 100.44, 100.54];
    const m = (beeld: number, sc: number | null, x = 0.6): ScherpteMeting => ({ t: 0, beeld, gezicht: sc === null ? null : { x, breedte: 0.08, scherpte: sc } });
    const ok = besluitScherpBegin(eerste, tijden, [m(400, 60), m(400, 60), m(400, 60), m(400, 60), m(400, 60), m(400, 60)]);
    toets('scherp gezicht vanaf het begin: niets doen', ok.status === 'ok');
    const laat = besluitScherpBegin(eerste, tijden, [m(60, 4), m(70, 5), m(400, 10), m(420, 40), m(420, 50), m(420, 50)]);
    toets('wazig begin, scherp na 0,3 s: bevriezen op dat frame', laat.status === 'bevries' && 't' in laat && Math.abs(laat.t - 100.34) < 1e-9, laat.detail);
    pasScherpBeginToe(eerste, laat);
    toets('bevroren begin gezet, kader op het scherpe gezicht', eerste.bevriesBegin?.tot === 0.34 && eerste.bevriesBegin?.bron === 100.34 && eerste.focusX === 0.6, JSON.stringify(eerste.bevriesBegin));
    const veelLater = [...tijden, 100.64, 100.74, 100.84];
    const ref = besluitScherpBegin({ ...shot(100, 106) }, veelLater, [m(60, 4), m(60, 4), m(60, 4), m(60, 4), m(60, 4), m(60, 4), m(60, 4), m(60, 4), m(400, 40)]);
    toets('scherp pas na > 0,6 s: alleen kaderreferentie, niet bevriezen', ref.status === 'referentie', ref.detail);
    const geen = besluitScherpBegin(eerste, tijden, tijden.map(() => m(400, null)));
    toets('nergens een gezicht: melden, niets forceren', geen.status === 'geen_scherp_gezicht');
  }

  console.log('splitdelen en de poort');
  {
    const A = persoon(0, 0, 0.3, 0, 3, praat);
    const C = persoon(2, 1, 0.55, 3, 6, praat);
    const st = actieveSprekers({ van: 0, tot: 6, stap: STAP, personen: [A, C], knippen: [3.05] }, spraakVan(0, 6, () => true));
    const ouder: Shot = { ...shot(0.5, 5.5), ankerStart: 0.5, ankerEind: 5.5, planStart: 0.5, planEnd: 5.5 };
    (ouder as { transcript_fragment?: string }).transcript_fragment = 'een lange zin die over de camerawissel heen loopt';
    const r = pasSprekersToe(ouder, st, null, { volgendeVolgorde: 2 });
    const tweede = r.delen[1] as Shot & { transcript_fragment?: string };
    toets('splitdeel heeft geen eigen scriptfragment (hoeft het ouderfragment niet te bewijzen)', r.delen.length === 2 && !tweede.transcript_fragment && (r.delen[0] as { transcript_fragment?: string }).transcript_fragment !== undefined);
    toets('splitdeel: plantijd = eigen begin (scriptcontrole zet het niet terug naar het ouderplan)', tweede.planStart === 3.05, String(tweede.planStart));
    // Camerawissel midden in een woord: het geluid loopt door, dus de poort
    // verschuift die grens niet en rekt er geen ademruimte aan.
    const woorden: BronWoord[] = [];
    for (let t = 0.6; t < 5.4; t += 0.4) woorden.push({ w: `w${Math.round(t * 10)}`, s: Math.round(t * 1000) / 1000, e: Math.round((t + 0.3) * 1000) / 1000 });
    const p = poort(r.delen.map((d) => ({ ...d })), woorden);
    const [a, b] = [...p.segmenten].sort((x, y) => x.volgorde - y.volgorde);
    toets('poort: doorlopende naad blijft exact aansluiten', p.segmenten.length === 2 && Math.abs(a.end - 3.05) < 1e-9 && Math.abs(b.start - 3.05) < 1e-9, JSON.stringify(p.segmenten.map((x) => [x.volgorde, x.start, x.end])) + ' ' + JSON.stringify(p.ingrepen));
    toets('poort: geen overlap/duplicaat door de split', !p.ingrepen.some((g) => g.regel === 'overlap' || g.regel === 'halfFragment'), JSON.stringify(p.ingrepen));
    const k = keurKnippen(p.segmenten, woorden);
    toets('keuring knippen: doorlopende naad in een woord telt niet als knip', k.goed === true && /doorlopende naad/.test(k.detail), k.detail);
  }

  console.log('herhaalde vraag in de bron');
  {
    const w = (tekst: string, van: number): BronWoord[] => tekst.split(' ').map((x, i) => ({ w: x, s: van + i * 0.3, e: van + i * 0.3 + 0.25 }));
    const bron = [...w('Zou jij dit dragen?', 10), ...w('Zou jij dit dragen?', 13), ...w('Ja tuurlijk.', 15)];
    const segs: Shot[] = [{ volgorde: 1, start: 9.9, end: 16, functie: 'setup' }];
    toets('twee keer gezegd in de bron: toegestaan (ook verhaspeld teruggehoord)', herhaaldInBron('Zij jij dit dragen?', segs, bron));
    toets('één keer in de bron: wél een dubbeling', !herhaaldInBron('Ja tuurlijk.', segs, bron) && !herhaaldInBron('Zou jij dit dragen?', [{ volgorde: 1, start: 9.9, end: 12, functie: 'setup' }], bron));
  }

  console.log('sprekerwissel binnen één standpunt: knip op woordgrens, anders pan');
  {
    const spraak = spraakVan(0, 10, () => true);
    const A = persoon(0, 0, 0.3, 0, 10, (t) => (t < 5 ? praat(t) : rustig(t)));
    const B = persoon(1, 0, 0.7, 0, 10, (t) => (t >= 5 ? praat(t) : rustig(t)));
    const st = actieveSprekers({ van: 0, tot: 10, stap: STAP, personen: [A, B], knippen: [] }, spraak);
    const wissel = st[1]?.van ?? 5;
    // Woorden met een gat vlak na de wissel.
    const woorden: BronWoord[] = [];
    for (let t = 0; t < 10; t += 0.4) if (!(t > wissel + 0.05 && t < wissel + 0.35)) woorden.push({ w: 'x', s: t, e: t + 0.3 });
    const metWoorden = pasSprekersToe(shot(0, 10), st, woorden);
    const grens = metWoorden.delen[1]?.start ?? -1;
    toets('harde knip', metWoorden.delen.length === 2 && metWoorden.wissels[0]?.soort === 'knip', JSON.stringify(metWoorden.wissels));
    toets('knip valt in een woordgat', woorden.every((w) => !(grens > w.s + 0.01 && grens < w.e - 0.01)) && Math.abs(grens - wissel) <= instelling('SPREKER_WOORDGRENS_MARGE') + 1e-6, String(grens));
    const zonder = pasSprekersToe(shot(0, 10), st, null);
    toets('zonder woordgrens: één deel met een snelle pan', zonder.delen.length === 1 && zonder.wissels[0]?.soort === 'pan');
    const sp = zonder.delen[0].spoor ?? [];
    const voor = sp.filter((p) => p.t < wissel - 0.2).every((p) => Math.abs(p.x - 0.3) < 0.02);
    const na = sp.filter((p) => p.t > wissel + 0.2).every((p) => Math.abs(p.x - 0.7) < 0.02);
    const tussen = sp.filter((p) => p.x > 0.32 && p.x < 0.68);
    const panDuur = tussen.length ? Math.max(...tussen.map((p) => p.t)) - Math.min(...tussen.map((p) => p.t)) : 0;
    toets('pan: vóór op A, na op B, en snel (≤ 0,35 s tussen de twee)', voor && na && panDuur <= 0.35, `duur ${panDuur.toFixed(2)}`);
  }

  console.log('tweeshot');
  {
    // Twee mensen dicht naast elkaar (0,45 en 0,58) die om de 2 s wisselen.
    const wie = (t: number) => Math.floor(t / 2) % 2;
    const P = persoon(0, 0, 0.45, 0, 10, (t) => (wie(t) === 0 ? praat(t) : rustig(t)));
    const Q = persoon(1, 0, 0.58, 0, 10, (t) => (wie(t) === 1 ? praat(t) : rustig(t)));
    const st = actieveSprekers({ van: 0, tot: 10, stap: STAP, personen: [P, Q], knippen: [] }, spraakVan(0, 10, () => true));
    toets('één tweeshot in plaats van pingpong', st.length === 1 && Boolean(st[0].tweeshot), JSON.stringify(st.map((s) => [s.van, s.tot, s.persoon?.id, Boolean(s.tweeshot)])));
    const r = pasSprekersToe(shot(0, 10), st, null);
    toets('tweeshot: kader tussen beiden, breed genoeg voor twee', Math.abs((r.delen[0].focusX ?? 0) - 0.515) < 0.01 && (r.delen[0].focusW ?? 0) >= 0.13 + 0.07 - 1e-6);
    // Ver uit elkaar: geen tweeshot (twee halve hoofden), maar wisselen.
    const Pver = { ...P, x: 0.2, monsters: P.monsters.map((m) => [m[0], 0.2, m[2]] as [number, number, number | null]) };
    const Qver = { ...Q, x: 0.8, monsters: Q.monsters.map((m) => [m[0], 0.8, m[2]] as [number, number, number | null]) };
    const ver = actieveSprekers({ van: 0, tot: 10, stap: STAP, personen: [Pver, Qver], knippen: [] }, spraakVan(0, 10, () => true));
    toets('ver uit elkaar: geen tweeshot, één persoon groot', ver.length >= 3 && ver.every((s) => !s.tweeshot));
  }

  console.log('dubbele sporen');
  {
    const a = persoon(0, 0, 0.5, 0, 2, rustig);
    const b = persoon(1, 0, 0.53, 2, 4, rustig);
    const c = persoon(2, 0, 0.8, 0, 4, rustig);
    const samen = voegDubbeleSamen([a, b, c]);
    toets('één persoon die even kwijt was wordt één spoor', samen.length === 2 && samen[0].monsters.length === a.monsters.length + b.monsters.length);
  }

  console.log('meting in gezichten.py (synthetische bron met camerawissel)');
  {
    const map = mkdtempSync(join(tmpdir(), 'clipper-test-sprekers-'));
    try {
      const bron = join(map, 'bron.mp4');
      const g = spawnSync(resolveBinary('ffmpeg'), [
        '-v', 'error', '-y',
        '-loop', '1', '-t', '1.2', '-i', 'scripts/fixtures/wijd-studio.jpg',
        '-loop', '1', '-t', '1.2', '-i', 'scripts/fixtures/wijd-studio.jpg',
        // Tweede "camera": hetzelfde beeld gespiegeld, dus de persoon staat aan de andere kant.
        // Een langzame camerabeweging (crop die opschuift): een echt beeld
        // staat nooit pixelstil, een afbeelding in een graphic wel.
        '-filter_complex',
        "[0]scale=2000:1125,setsar=1,fps=25,crop=1920:1080:'40+t*60':20[a];[1]scale=2000:1125,setsar=1,hflip,fps=25,crop=1920:1080:'40+t*60':20[b];[a][b]concat=n=2:v=1[v]",
        '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', bron,
      ]);
      toets('testbron gemaakt', g.status === 0, String(g.stderr).slice(-200));
      let m: SprekerMeting[] = [];
      let fout = '';
      try {
        m = await meetSprekers(bron, [{ van: 0, tot: 2.4 }], pythonMetOpenCV());
      } catch (e) {
        fout = (e as Error).message;
      }
      if (fout && /No module named|ImportError/.test(fout)) {
        console.log('  (geen OpenCV op deze machine; meting overgeslagen)');
      } else {
        toets('meting geeft één resultaat per bereik', m.length === 1, fout);
        const knip = m[0]?.knippen ?? [];
        toets('camerawissel op het frame gevonden (1,2 s)', knip.length === 1 && Math.abs(knip[0] - 1.2) <= 0.041, JSON.stringify(knip));
        const scenes = new Set((m[0]?.personen ?? []).map((p) => p.scene));
        toets('gezichten in beide standpunten, sporen per standpunt', scenes.has(0) && scenes.has(1), JSON.stringify(m[0]?.personen.map((p) => [p.scene, p.x, p.n])));
        const p0 = m[0]?.personen.find((p) => p.scene === 0);
        const p1 = m[0]?.personen.find((p) => p.scene === 1);
        toets('na de knip een nieuw spoor op de gespiegelde plek', Boolean(p0 && p1 && Math.abs(p1.x - (1 - p0.x)) < 0.05), `${p0?.x} / ${p1?.x}`);
        // Zonder praten blijft de mondbeweging ver onder spreekniveau (gemeten 5–12 bij sprekers), ook als de camera beweegt.
        const mond = (m[0]?.personen ?? []).flatMap((p) => p.monsters.map((x) => x[2])).filter((x): x is number => x !== null).sort((x, y) => x - y);
        const med = mond[Math.floor(mond.length / 2)] ?? 99;
        toets('niemand praat: mondbeweging ver onder spreekniveau (camera beweegt)', med < 3, `mediaan ${med}`);
        // Een pixelstil gezicht (bankbiljet in een graphic, poster aan de muur) is geen persoon.
        const stil = join(map, 'stil.mp4');
        spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-y', '-loop', '1', '-t', '2', '-i', 'scripts/fixtures/wijd-studio.jpg', '-vf', 'scale=1920:1080,setsar=1,fps=25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', stil]);
        const ms = await meetSprekers(stil, [{ van: 0, tot: 2 }], pythonMetOpenCV());
        toets('pixelstil gezicht (afbeelding) telt niet als persoon', ms[0]?.personen.length === 0, JSON.stringify(ms[0]?.personen.map((p) => p.x)));
        // Ook in de gewone meting (kadrering, scènes): een pixelstil gezicht
        // (bankbiljet, horlogewijzerplaat) is geen persoonsbeeld; een echt
        // (bewegend) beeld van hetzelfde gezicht wel.
        const py = pythonMetOpenCV();
        const gewoon = (pad: string) => {
          const r = spawnSync(py.cmd, [...py.voor, 'scripts/gezichten.py', pad, '[1.0]', '3'], { encoding: 'utf8' });
          const regel = (r.stdout ?? '').split('\n').reverse().find((x) => x.trim().startsWith('['));
          return regel ? (JSON.parse(regel) as unknown[])[0] : 'fout';
        };
        toets('gewone meting: pixelstil gezicht → geen gezicht', gewoon(stil) === null);
        toets('gewone meting: bewegend beeld → wel een gezicht', gewoon(bron) !== null && gewoon(bron) !== 'fout');
        // Scherpte: hetzelfde beeld scherp en met bewegingsonscherpte.
        const wazig = join(map, 'wazig.mp4');
        spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-y', '-i', stil, '-vf', 'gblur=sigma=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', wazig]);
        const [sc] = await scherpteMeterVia(stil, py)([1.0]);
        const [wz] = await scherpteMeterVia(wazig, py)([1.0]);
        console.log(`    scherpte: scherp beeld ${sc?.beeld} / gezicht ${sc?.gezicht?.scherpte}; wazig beeld ${wz?.beeld} / gezicht ${wz?.gezicht?.scherpte ?? '—'}`);
        toets('scherptemeting: wazig beeld scoort veel lager', Boolean(sc && wz && sc.beeld > 3 * wz.beeld), `${sc?.beeld} vs ${wz?.beeld}`);
        toets('scherp gezicht boven de drempel, wazig eronder of niet gevonden', Boolean(sc?.gezicht && sc.gezicht.scherpte >= instelling('SCHERP_MIN_GEZICHT') && (!wz?.gezicht || wz.gezicht.scherpte < instelling('SCHERP_MIN_GEZICHT'))), JSON.stringify([sc?.gezicht, wz?.gezicht]));
        toets('monsters op 0,1 s', (m[0]?.personen[0]?.monsters.length ?? 0) >= 8);
      }
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  }

  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
