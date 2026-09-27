/**
 * Tests voor de renderbron (src/lib/roughcut/renderbron.ts), zonder netwerk:
 * het sectieplan (marges, samenvoegen, grenzen), de offsets, de audio-
 * uitlijning van een sectie die op een keyframe vóór het gevraagde punt
 * begint (precies wat --download-sections zonder --force-keyframes-at-cuts
 * doet), en een render uit secties die beeld voor beeld gelijk moet zijn aan
 * een render uit de analysebron.
 *
 * De "download" is hier een ffmpeg-stream-copy uit een gegenereerde bron met
 * een keyframe per 2 s — dezelfde mechaniek als yt-dlp met ffmpeg.
 *
 * Draaien: npm run test:renderbron
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { haalRenderSecties, lijnBeeldUit, sectiePlan, sectieTijd, sectieVoor, type SectieBestand } from '../src/lib/roughcut/renderbron';
import { maakRuweMontage, type Shot } from '../src/lib/roughcut';

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

function ff(args: string[]): { ok: boolean; uit: string } {
  const res = spawnSync(resolveBinary('ffmpeg'), ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8' });
  return { ok: res.status === 0, uit: `${res.stdout}${res.stderr}` };
}

async function frameGrijs(pad: string, t: number): Promise<Buffer> {
  const uit = join(tmpdir(), `rb-frame-${process.pid}-${Math.random().toString(36).slice(2)}.raw`);
  ff(['-ss', t.toFixed(3), '-i', pad, '-frames:v', '1', '-vf', 'scale=96:54', '-f', 'rawvideo', '-pix_fmt', 'gray', uit]);
  const buf = existsSync(uit) ? await readFile(uit) : Buffer.alloc(0);
  await rm(uit, { force: true });
  return buf;
}
const verschil = (a: Buffer, b: Buffer) => {
  if (a.length === 0 || a.length !== b.length) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

async function main() {
  console.log('sectieplan');
  {
    const plan = sectiePlan(
      [
        { start: 100, end: 110 },
        { start: 112, end: 118 }, // gat 2 s → samen
        { start: 140, end: 150 }, // gat 22 s (na marges 18) → eigen sectie
        { start: 1, end: 3 },
      ],
      { marge: 2, samenvoegGat: 15, duur: 149 },
    );
    toets('bereiken op volgorde, marge 2 s, begrensd op 0', plan[0].van === 0 && plan[0].tot === 5, JSON.stringify(plan));
    toets('nabije bereiken samengevoegd', plan.some((p) => p.van === 98 && p.tot === 120), JSON.stringify(plan));
    toets('ver uit elkaar blijft apart, begrensd op de videoduur', plan.some((p) => p.van === 138 && p.tot === 149), JSON.stringify(plan));
    toets('drie secties in totaal', plan.length === 3, JSON.stringify(plan));
    const samen = sectiePlan([{ start: 10, end: 20 }, { start: 30, end: 40 }], { marge: 2, samenvoegGat: 15 });
    toets('gat van 6 s na marges < 15 s → één sectie', samen.length === 1 && samen[0].van === 8 && samen[0].tot === 42, JSON.stringify(samen));
    toets('lege of omgekeerde bereiken vallen weg', sectiePlan([{ start: 5, end: 5 }, { start: 9, end: 3 }]).length === 0);
  }

  console.log('offsets');
  {
    const s: SectieBestand = { van: 98, tot: 120, pad: 'x', bronStart: 97.2, duur: 23, breedte: 3840, hoogte: 2160, codec: 'vp9', bytes: 1, correlatie: 1 };
    toets('brontijd → sectietijd', Math.abs(sectieTijd(s, 100) - 2.8) < 1e-9);
    toets('shot binnen de sectie wordt gevonden', sectieVoor([s], 99, 119) === s);
    toets('shot buiten de sectie → analysebron', sectieVoor([s], 96, 110) === null && sectieVoor([s], 110, 121) === null);
  }

  const map = join(tmpdir(), `clipper-test-renderbron-${process.pid}`);
  await rm(map, { recursive: true, force: true });
  const werk = join(map, 'werk');
  await mkdir(werk, { recursive: true });
  try {
    // De "analysebron": 40 s testbeeld (keyframe elke 2 s) met ruis waarvan
    // het volume golft — zodat de audio een unieke vingerafdruk heeft.
    const analyse = join(werk, 'bron.mp4');
    const gen = ff([
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=40',
      '-f', 'lavfi', '-i', "anoisesrc=seed=7:a=0.4:d=40,volume='0.15+0.85*abs(sin(t*1.7)*sin(t*0.61+1))':eval=frame",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', analyse,
    ]);
    toets('analysebron gegenereerd', gen.ok, gen.uit.slice(-200));

    console.log('uitlijning van een sectie die op een keyframe vóór het gevraagde punt begint');
    // "Download": stream copy vanaf 21,3 s — het bestand begint dan op het
    // keyframe op 20 s, niet op 21,3. Precies de onzekerheid die we meten.
    const downloader = async (sectie: { van: number; tot: number }, pad: string) => {
      const r = ff(['-ss', sectie.van.toFixed(2), '-to', sectie.tot.toFixed(2), '-i', analyse, '-c', 'copy', pad]);
      if (!r.ok) throw new Error(r.uit.slice(-200));
    };
    const rb = await haalRenderSecties({
      sourceUrl: 'https://voorbeeld.test/video',
      analyseBron: analyse,
      plan: [{ van: 21.3, tot: 33.7 }],
      map: join(werk, 'secties'),
      videoDuur: 40,
      downloader,
      log: (m) => console.log(`  (${m})`),
    });
    toets('sectie gedownload en uitgelijnd', rb.secties.length === 1 && rb.fouten.length === 0, JSON.stringify(rb.fouten));
    const s = rb.secties[0];
    if (s) {
      // Waarheid via het beeld: een frame op sectietijd T moet gelijk zijn aan
      // het frame op brontijd bronStart + T in de analysebron.
      const a = await frameGrijs(s.pad, 3.0);
      const b = await frameGrijs(analyse, s.bronStart + 3.0);
      const naast = await frameGrijs(analyse, s.bronStart + 3.2);
      toets('beeld klopt met de gemeten offset (frame-gelijk)', verschil(a, b) < 2, `verschil ${verschil(a, b).toFixed(2)} (5 frames ernaast: ${verschil(a, naast).toFixed(2)})`);
      toets('offset ligt op of vóór het gevraagde begin (keyframe ervoor)', s.bronStart <= 21.3 + 0.05 && s.bronStart >= 19.9, String(s.bronStart));
      toets('correlatie hoog', s.correlatie >= 0.9, String(s.correlatie));
      toets('schatting volle video en MB gelogd', rb.geschatVolMb !== null && rb.mbGedownload > 0, JSON.stringify({ mb: rb.mbGedownload, vol: rb.geschatVolMb }));

      console.log('cache');
      let opnieuwGedownload = false;
      const rb2 = await haalRenderSecties({
        sourceUrl: 'https://voorbeeld.test/video', analyseBron: analyse, plan: [{ van: 22, tot: 30 }], map: join(werk, 'secties'),
        downloader: async (x, p) => { opnieuwGedownload = true; await downloader(x, p); },
      });
      toets('een sectie binnen een eerdere wordt hergebruikt', !opnieuwGedownload && rb2.secties.length === 1 && rb2.mbGedownload === 0);

      console.log('render uit de sectie');
      const shots: Shot[] = [
        { volgorde: 1, start: 23.0, end: 26.0, functie: 'setup', focusX: 0.5, focusW: 0.12 },
        { volgorde: 2, start: 28.0, end: 31.0, functie: 'payoff', focusX: 0.5, focusW: 0.12 },
      ];
      const uitSectie = join(map, 'uit-sectie.mp4');
      const uitAnalyse = join(map, 'uit-analyse.mp4');
      const r1 = await maakRuweMontage({ sourceUrl: 'lokaal://test', shots, alGesegmenteerd: true, outputPad: uitSectie, werkmap: werk, kader: 'vullend', renderBron: rb });
      await maakRuweMontage({ sourceUrl: 'lokaal://test', shots, alGesegmenteerd: true, outputPad: uitAnalyse, werkmap: werk, kader: 'vullend' });
      toets('beide shots uit de sectie', r1.kwaliteit.renderbron?.shotsUitSectie === 2 && r1.kwaliteit.renderbron.shotsTerugval === 0, JSON.stringify(r1.kwaliteit.renderbron));
      for (const t of [0.5, 2.5, 4.0]) {
        const d = verschil(await frameGrijs(uitSectie, t), await frameGrijs(uitAnalyse, t));
        toets(`beeld op ${t} s gelijk aan de render uit de analysebron`, d < 3, `verschil ${d.toFixed(2)}`);
      }
      // Geluid: dezelfde brontijd moet hetzelfde klinken — kruiscorrelatie
      // van de twee eindmixen, piek op 0 ms.
      const pcm = (pad: string) => {
        const r = spawnSync(resolveBinary('ffmpeg'), ['-nostdin', '-i', pad, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 1e8 });
        return new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 2));
      };
      const pa = pcm(uitSectie);
      const pb = pcm(uitAnalyse);
      let beste = { lag: 0, c: -Infinity };
      for (let lag = -80; lag <= 80; lag++) {
        let c = 0;
        for (let i = 4000; i < 36000; i++) c += pa[i] * (pb[i + lag] ?? 0);
        if (c > beste.c) beste = { lag, c };
      }
      toets('geluid synchroon met de analyserender (binnen 2 ms)', Math.abs(beste.lag) <= 16, `${(beste.lag / 8).toFixed(1)} ms`);

      // Een shot dat buiten de sectie valt, rendert uit de analysebron.
      const buiten: Shot[] = [{ volgorde: 1, start: 35, end: 38, functie: 'setup', focusX: 0.5, focusW: 0.12 }];
      const r3 = await maakRuweMontage({ sourceUrl: 'lokaal://test', shots: buiten, alGesegmenteerd: true, outputPad: join(map, 'buiten.mp4'), werkmap: werk, kader: 'vullend', renderBron: rb });
      toets('shot buiten de sectie valt terug op de analysebron', r3.kwaliteit.renderbron?.shotsTerugval === 1);
    }

    console.log('beeld en geluid van een sectie lopen uiteen (DASH: twee losse stromen)');
    {
      // Sectie waarvan het beeld 1,5 s eerder in de bron begint dan het
      // geluid: beeld vanaf 19,8 s, geluid vanaf 21,3 s, samen in één bestand.
      const scheef = async (sectie: { van: number; tot: number }, pad: string) => {
        const r = ff([
          '-ss', (sectie.van - 1.5).toFixed(2), '-i', analyse, '-ss', sectie.van.toFixed(2), '-i', analyse,
          '-map', '0:v', '-map', '1:a', '-t', (sectie.tot - sectie.van).toFixed(2),
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', pad,
        ]);
        if (!r.ok) throw new Error(r.uit.slice(-200));
      };
      const rbs = await haalRenderSecties({
        sourceUrl: 'https://voorbeeld.test/video', analyseBron: analyse, plan: [{ van: 21.3, tot: 33.7 }],
        map: join(werk, 'secties-scheef'), downloader: scheef, log: (m) => console.log(`  (${m})`),
      });
      const sc = rbs.secties[0];
      toets('geluid op 21,3 s uitgelijnd', Boolean(sc) && Math.abs(sc.bronStart - 21.3) < 0.02, JSON.stringify(sc?.bronStart));
      toets('beeld apart gemeten: 1,5 s eerder, en gecorrigeerd', Boolean(sc) && Math.abs((sc.videoStart ?? 0) - 19.8) < 0.05, JSON.stringify({ video: sc?.videoStart, verschil: sc?.beeldVerschil, zekerheid: sc?.beeldZekerheid }));
      if (sc) {
        const shots: Shot[] = [{ volgorde: 1, start: 24.0, end: 27.0, functie: 'setup', focusX: 0.5, focusW: 0.12 }];
        const uitS = join(map, 'scheef-sectie.mp4');
        const uitA = join(map, 'scheef-analyse.mp4');
        await maakRuweMontage({ sourceUrl: 'lokaal://test', shots, alGesegmenteerd: true, outputPad: uitS, werkmap: werk, kader: 'vullend', renderBron: rbs });
        await maakRuweMontage({ sourceUrl: 'lokaal://test', shots, alGesegmenteerd: true, outputPad: uitA, werkmap: werk, kader: 'vullend' });
        const d = verschil(await frameGrijs(uitS, 1.5), await frameGrijs(uitA, 1.5));
        toets('render uit de scheve sectie toont het juiste beeld', d < 3, `verschil ${d.toFixed(2)}`);
      }
      // Een stilstaand beeld is niet uit te lijnen: dan geen correctie.
      const stilPad = join(werk, 'stil.mp4');
      ff(['-f', 'lavfi', '-i', 'color=c=gray:size=320x180:rate=25:duration=12', '-f', 'lavfi', '-i', 'anullsrc', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', stilPad]);
      const stil = await lijnBeeldUit(stilPad, stilPad, 2);
      toets('stilstaand beeld: geen zekere beeldmeting', stil === null || stil.zekerheid < 0.25, JSON.stringify(stil));
    }

    console.log('terugval bij een mislukte download');
    {
      const mis = await haalRenderSecties({
        sourceUrl: 'https://voorbeeld.test/video', analyseBron: analyse, plan: [{ van: 2, tot: 9 }], map: join(werk, 'secties-mis'),
        downloader: async () => {
          throw new Error('Sign in to confirm you are not a bot');
        },
      });
      toets('mislukte sectie wordt gemeld, niet fataal', mis.secties.length === 0 && mis.fouten.length === 1 && /bot/.test(mis.fouten[0]), JSON.stringify(mis.fouten));
      const stil = await haalRenderSecties({
        sourceUrl: 'https://voorbeeld.test/video', analyseBron: analyse, plan: [{ van: 2, tot: 9 }], map: join(werk, 'secties-stil'),
        downloader: async (_x, p) => {
          const r = ff(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=7', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '7', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', p]);
          if (!r.ok) throw new Error('gen');
        },
      });
      toets('sectie met andere/stille audio wordt niet vertrouwd', stil.secties.length === 0 && /uitlijning onzeker/.test(stil.fouten[0] ?? ''), JSON.stringify(stil.fouten));
    }
  } finally {
    await rm(map, { recursive: true, force: true });
  }

  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
