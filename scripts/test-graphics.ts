/**
 * Tests voor graphics: de inhoudsmeting op echte GoldRepublic-frames (oranje
 * verloop met vignet, logo in de hoek — scripts/fixtures/) en de
 * leestijdregel (leestijd.ts) op gestubde deelstukken. Zonder netwerk.
 *
 * Draaien: npm run test:graphics
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { analyseerGraphic, graphicMeterVia, inhoudKader, lijktGraphic, stabieleInhoud } from '../src/lib/roughcut/graphics';
import { keurGraphicsDetail, type GraphicFout } from '../src/lib/roughcut/keuring';
import { herstelNaKeuring, zelfherstelStap } from '../src/lib/roughcut/herstel';
import { deelstukken, vulScenes, type GezichtMeter } from '../src/lib/roughcut/scenes';
import { keurGraphics } from '../src/lib/roughcut/keuring';
import { behandelEindscherm, keurOverlay, overlayUitPixels, vermijdOverlay } from '../src/lib/roughcut/eindscherm';
import { plakKoppeltekens } from '../src/lib/roughcut/ondertitels';
import { pythonMetOpenCV } from '../src/lib/python';
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

async function vervolg() {
  const fix = (n: string) => join(process.cwd(), 'scripts', 'fixtures', n);
  const map = mkdtempSync(join(tmpdir(), 'clipper-test-graphics-'));
  const video = (jpg: string, naam: string) => {
    const uit = join(map, naam);
    spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-y', '-loop', '1', '-i', jpg, '-t', '4', '-r', '25', '-vf', 'scale=1920:1080', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', uit]);
    return uit;
  };
  try {
    console.log('graphic of camerabeeld? (vlakheid)');
    for (const n of ['graphic-voorraden.jpg', 'graphic-39.jpg']) {
      const a = analyseerGraphic(pixels(fix(n)), 480, 270);
      toets(`${n} lijkt een graphic`, lijktGraphic(a), `vlak ${a.vlak.toFixed(2)}`);
    }
    for (const n of ['wijd-studio.jpg', 'wijd-studio-2.jpg', 'eindscherm.jpg']) {
      const a = analyseerGraphic(pixels(fix(n)), 480, 270);
      toets(`${n} is een camerabeeld, geen graphic`, !lijktGraphic(a), `vlak ${a.vlak.toFixed(2)}`);
    }

    console.log('geen gezicht gevonden + camerabeeld = wijd shot, vullend');
    {
      const studio = video(fix('wijd-studio.jpg'), 'studio.mp4');
      const graphic = video(fix('graphic-39.jpg'), 'graphic.mp4');
      const geenGezicht: GezichtMeter = async (t) => t.map(() => false);
      const wijd: Shot = { volgorde: 1, start: 0.1, end: 3.9, functie: 'setup' };
      const r1 = await vulScenes(studio, [wijd], geenGezicht);
      toets('camerabeeld zonder gezicht wordt als wijd shot herkend', r1.wijd === 1 && r1.graphic === 0, JSON.stringify(r1));
      toets('en krijgt het vullende kader (geen postzegel)', deelstukken(wijd, 'vullend').every((d) => d.kader === 'vullend'), JSON.stringify(deelstukken(wijd, 'vullend')));
      const g: Shot = { volgorde: 1, start: 0.1, end: 3.9, functie: 'setup' };
      const r2 = await vulScenes(graphic, [g], geenGezicht);
      toets('echte graphic blijft graphic (passend)', r2.graphic === 1 && deelstukken(g, 'vullend')[0].kader === 'blur', JSON.stringify(r2));
      const keurWijd = await keurGraphics([{ volgorde: 1, start: 0.1, end: 3.9, functie: 'setup' }], 'vullend', geenGezicht, graphicMeterVia(studio));
      toets('keuring: vullend wijd camerabeeld zonder gezicht is goed', keurWijd.goed === true && /1 wijd/.test(keurWijd.detail), keurWijd.detail);
      const keurFout = await keurGraphics([{ volgorde: 1, start: 0.1, end: 3.9, functie: 'setup' }], 'vullend', geenGezicht, graphicMeterVia(graphic));
      toets('keuring: vullende graphic blijft fout', keurFout.goed === false, keurFout.detail);
    }

    console.log('klein gezicht in een heel wijd shot (gezichten.py)');
    {
      const heel = video(fix('heel-wijd.jpg'), 'heelwijd.mp4');
      const py = pythonMetOpenCV();
      const r = spawnSync(py.cmd, [...py.voor, 'scripts/gezichten.py', heel, '[1.0, 2.0]', '1'], { encoding: 'utf8' });
      const regel = (r.stdout ?? '').split('\n').reverse().find((x) => x.trim().startsWith('['));
      const m = regel ? (JSON.parse(regel) as ({ breedte: number } | null)[]) : [];
      toets('gezicht van ~4% beeldbreedte gevonden', m.length === 2 && m.every((x) => x && x.breedte < 0.06), regel?.slice(0, 120) ?? r.stderr?.slice(-200));
    }

    console.log('eindscherm');
    {
      const rgb = spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-i', fix('eindscherm.jpg'), '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e8 }).stdout;
      const o = overlayUitPixels(rgb, 320, 180);
      toets('abonneerknoppen gevonden in de onderste helft', o !== null && o.y0 > 0.6 && o.x0 < 0.4 && o.x1 > 0.6, JSON.stringify(o));
      for (const n of ['wijd-studio.jpg', 'graphic-39.jpg']) {
        const px = spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-i', fix(n), '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e8 }).stdout;
        toets(`${n}: geen valse overlay (rood haar, oranje graphic)`, overlayUitPixels(px, 320, 180) === null);
      }
      if (o) {
        const seg: Shot = { volgorde: 6, start: 330, end: 333, functie: 'button', focusX: 0.5, focusW: 0.13, gezicht: { x: 0.5, breedte: 0.13, top: 0.21, hoogte: 0.3 }, overlay: o };
        toets('zonder ingreep: keuring ziet de overlay in beeld', keurOverlay([seg], 'vullend').goed === false, keurOverlay([seg], 'vullend').detail);
        toets('kader boven de overlay gelegd', vermijdOverlay(seg), JSON.stringify(seg));
        toets('daarna: overlay buiten beeld, keuring goed', keurOverlay([seg], 'vullend').goed === true, `${keurOverlay([seg], 'vullend').detail} zoom ${seg.zoom} focusY ${seg.focusY}`);
        toets('gezicht blijft in beeld', (seg.focusY ?? 0) - 1 / (2 * (seg.zoom ?? 1)) <= 0.21 && (seg.focusY ?? 0) + 1 / (2 * (seg.zoom ?? 1)) >= 0.51);
        // Kin in de overlay: niet weg te kadreren → inkorten tot vóór de overlay.
        const laag: Shot = { volgorde: 6, start: 330, end: 338, functie: 'button', focusX: 0.5, gezicht: { x: 0.5, breedte: 0.13, top: 0.4, hoogte: 0.4 } };
        const meter = async (t: number[]) => t.map((x) => (x >= 334 ? o : null));
        const woorden = Array.from({ length: 20 }, (_, i) => ({ w: `w${i}`, s: 330 + i * 0.4, e: 330 + i * 0.4 + 0.3 }));
        const es = await behandelEindscherm([laag], { bronDuur: 353, meter, bronWoorden: woorden });
        toets('niet weg te kadreren → ingekort tot vóór de overlay', es.ingekort === 1 && laag.end < 334 && laag.end > 332, JSON.stringify({ es, eind: laag.end }));
        const vroeg: Shot = { volgorde: 1, start: 100, end: 110, functie: 'setup' };
        const es2 = await behandelEindscherm([vroeg], { bronDuur: 353, meter: async (t) => t.map(() => o) });
        toets('shots buiten de laatste 30 s worden niet getoetst', es2.gemeten === 0);
      }
    }

    console.log('animerende graphic: niet inzoomen');
    {
      const vast = { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9 };
      toets('stilstaande inhoud is stabiel', stabieleInhoud([vast, vast, { ...vast, x1: 0.82 }]));
      toets('inhoud die inanimeert (klein → groot) is niet stabiel', !stabieleInhoud([{ x0: 0.2, y0: 0.3, x1: 0.4, y1: 0.7 }, vast, vast]));
      toets('een onbetrouwbare meting maakt het onstabiel', !stabieleInhoud([vast, null, vast]));
    }

    console.log('keuring "graphics passend": camerabeeld in het passende kader');
    {
      const studio = video(fix('wijd-studio.jpg'), 'studio2.mp4');
      const geenGezicht: GezichtMeter = async (t) => t.map(() => false);
      const seg: Shot = { volgorde: 3, start: 0.2, end: 3.8, functie: 'setup', scenes: [{ van: 0.2, tot: 3.8, gezicht: false }] };
      const r = await keurGraphicsDetail([seg], 'vullend', geenGezicht, graphicMeterVia(studio));
      toets('postzegel gevonden', r.fouten.length === 1 && r.fouten[0].soort === 'camerabeeld_passend', JSON.stringify(r.fouten));
      toets('regel is fout', r.regel.goed === false, r.regel.detail);
    }

    console.log('zelfherstel: herstelacties');
    {
      const box = { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.8 };
      const segs: Shot[] = [
        { volgorde: 3, start: 130, end: 137, functie: 'setup', scenes: [{ van: 130, tot: 132, gezicht: true }, { van: 132, tot: 137, gezicht: false, inhoud: box }] },
        { volgorde: 4, start: 175, end: 181, functie: 'escalatie', scenes: [{ van: 175, tot: 177, gezicht: false }, { van: 177, tot: 181, gezicht: true }] },
        { volgorde: 5, start: 200, end: 205, functie: 'escalatie' },
        { volgorde: 6, start: 330, end: 336, functie: 'button', overlay: box, overlayVanaf: 334 },
      ];
      const fouten: GraphicFout[] = [
        { soort: 'inhoud_buiten_beeld', volgorde: 3, van: 132, tot: 137, wat: 'x' },
        { soort: 'camerabeeld_passend', volgorde: 4, van: 175, tot: 177, wat: 'y' },
        { soort: 'graphic_vullend', volgorde: 5, van: 201, tot: 203, wat: 'z' },
      ];
      const woorden = Array.from({ length: 15 }, (_, i) => ({ w: `w${i}`, s: 330 + i * 0.4, e: 330 + i * 0.4 + 0.3 }));
      const acties = herstelNaKeuring(segs, fouten, [{ volgorde: 6 }], { bronWoorden: woorden });
      toets('inzoom eraf bij inhoud buiten beeld', segs[0].scenes?.[1].inhoud === null && deelstukken(segs[0], 'vullend')[1].kader === 'blur');
      toets('camerabeeld in passend → vullend', segs[1].scenes?.[0].gezicht === true && deelstukken(segs[1], 'vullend').every((d) => d.kader === 'vullend'));
      toets('graphic vullend → passend deelstuk op precies dat stuk', deelstukken(segs[2], 'vullend').map((d) => d.kader).join(',') === 'vullend,blur,vullend', JSON.stringify(deelstukken(segs[2], 'vullend')));
      toets('eindscherm → ingekort vóór de overlay (woordgrens)', segs[3].end < 334 && segs[3].end > 332 && !segs[3].overlay, String(segs[3].end));
      toets('vier acties gelogd', acties.length === 4, acties.join(' | '));
    }

    console.log('zelfherstel: de lus met gestubde keuring');
    {
      const box = { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.8 };
      const seg: Shot = { volgorde: 3, start: 130, end: 137, functie: 'setup', scenes: [{ van: 130, tot: 137, gezicht: false, inhoud: box }] };
      // De "keuring" faalt zolang er nog ingezoomd wordt; de "render" doet niets.
      const keur = async () => ({
        graphic: seg.scenes?.some((sc) => sc.inhoud)
          ? [{ soort: 'inhoud_buiten_beeld' as const, volgorde: 3, van: 130, tot: 137, wat: 'shot 3 130.0s: graphic-inhoud valt buiten beeld na inzoomen' }]
          : [],
        overlay: [],
      });
      let ronde = 0;
      let renders = 1;
      const logs: string[] = [];
      for (let poging = 1; poging <= 6; poging++) {
        const stap = await zelfherstelStap([seg], keur, { ronde, maxRondes: 2 });
        ronde = stap.ronde;
        if (stap.log) logs.push(stap.log);
        if (stap.opnieuw) {
          renders++;
          continue;
        }
        break;
      }
      toets('na één herstelronde goed: één extra render', renders === 2 && ronde === 1, JSON.stringify({ renders, ronde, logs }));
      toets('logregels "zelfherstel ronde 1: …" en "na ronde 1 … in orde"', /^zelfherstel ronde 1: .* → shot 3 130\.0s: inzoom eraf/.test(logs[0] ?? '') && /na ronde 1/.test(logs[1] ?? ''), logs.join(' | '));

      // Een fout die niet te herstellen is: de lus stopt, geen eindeloos renderen.
      const koppig = async () => ({ graphic: [], overlay: [{ volgorde: 99, wat: 'shot 99: eindscherm' }] });
      let r2 = 0;
      let n2 = 0;
      for (let poging = 1; poging <= 6; poging++) {
        const stap = await zelfherstelStap([seg], koppig, { ronde: r2, maxRondes: 2 });
        r2 = stap.ronde;
        n2++;
        if (!stap.opnieuw) break;
      }
      toets('onherstelbaar: stopt meteen (review via de eindkeuring)', n2 === 1 && r2 === 1);
      // Maximaal twee rondes, ook als elke ronde iets "herstelt" maar het blijft falen.
      let r3 = 0;
      let n3 = 0;
      const altijd = async () => ({ graphic: [{ soort: 'camerabeeld_passend' as const, volgorde: 3, van: 130, tot: 137, wat: 'x' }], overlay: [] });
      for (let poging = 1; poging <= 6; poging++) {
        const stap = await zelfherstelStap([{ ...seg, scenes: [{ van: 130, tot: 137, gezicht: false }] }], altijd, { ronde: r3, maxRondes: 2 });
        r3 = stap.ronde;
        n3++;
        if (!stap.opnieuw) break;
      }
      toets('hoogstens twee herstelrondes', r3 === 2 && n3 === 3, JSON.stringify({ r3, n3 }));
    }

    console.log('ondertitels: koppeltekens bij elkaar');
    {
      const w = plakKoppeltekens([
        { w: 'Zuid', s: 0, e: 0.3 }, { w: '-Afrika.', s: 0.3, e: 0.7 },
        { w: 'EV-', s: 1, e: 1.2 }, { w: 'adoptie', s: 1.2, e: 1.6 }, { w: 'groeit', s: 1.7, e: 2 },
      ]);
      toets('"Zuid" + "-Afrika." → "Zuid-Afrika."', w[0].w === 'Zuid-Afrika.' && w[0].e === 0.7, JSON.stringify(w));
      toets('"EV-" + "adoptie" → "EV-adoptie"', w[1].w === 'EV-adoptie', JSON.stringify(w));
      toets('gewone woorden blijven los', w.length === 3 && w[2].w === 'groeit');
    }
  } finally {
    rmSync(map, { recursive: true, force: true });
  }

  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
}

vervolg().catch((e) => {
  console.error(e);
  process.exit(1);
});
