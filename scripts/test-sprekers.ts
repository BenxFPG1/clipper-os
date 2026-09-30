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
import { actieveSprekers, meetSprekers, pasSprekersToe, voegDubbeleSamen, type SprekerMeting, type SprekerPersoon } from '../src/lib/roughcut/sprekers';
import { instelling } from '../src/lib/roughcut/instellingen';
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
