/**
 * Integratietest van de renderketen zonder netwerk en zonder model.
 *
 * Genereert met ffmpeg zelf een bronvideo (testsrc + sinus), zet die op de
 * plek waar de montage hem verwacht (werkmap/bron.mp4, dus geen download) en
 * draait maakRuweMontage met alles aan: bronframerate, tweepass-loudnorm,
 * muziekbed met ramp naar stilte, punch_in en snelle_zoom als zoompan,
 * sfx, tekstkaart-overlay en woordelijke ondertitels (ASS als deze ffmpeg
 * libass heeft, anders de PNG-terugval). Daarna brandOverlays voor de
 * hookvarianten. Elke filterketen die hier doorheen komt is syntactisch
 * goed; wat hier faalt, faalt in CI ook.
 *
 * Draaien: npm run test:render
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { brandOverlays, fpsVoorRender, maakRuweMontage, pasNaadZoomToe, probeBron, type Shot } from '../src/lib/roughcut';
import { effectKeten } from '../src/lib/roughcut/kader';
import { bouwAss, groepeerRegels, heeftAssFilter, maakOndertitels, woordenOpTijdlijn } from '../src/lib/roughcut/ondertitels';
import { tekenHookKaart, hookDuur } from '../src/lib/roughcut/tekstkaarten';
import type { BronWoord } from '../src/lib/roughcut/woorden';
import { keurRetentie, pasRetentieToe } from '../src/lib/roughcut/retentie';
import { poort } from '../src/lib/roughcut/poort';
import { keurKnippen } from '../src/lib/roughcut/keuring';
import { STANDAARD_DOELEN } from '../src/lib/vault/normen';
import { deelstukken, detecteerSceneKnippen, strijkGlad, vulScenes, type GezichtMeter } from '../src/lib/roughcut/scenes';
import { keurGraphics } from '../src/lib/roughcut/keuring';
import { plaatsRegels, ondertitelMaat, gezichtOpBeeld, fontKlopt } from '../src/lib/roughcut/ondertitels';
import { kaderKeten } from '../src/lib/roughcut/kader';
import { readFile } from 'node:fs/promises';

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

function probe(pad: string): { duur: number; fps: string; streams: string[] } {
  const res = spawnSync(
    resolveBinary('ffprobe'),
    ['-v', 'error', '-show_entries', 'stream=codec_type,r_frame_rate:format=duration', '-of', 'json', pad],
    { encoding: 'utf8' },
  );
  const j = JSON.parse(res.stdout || '{}') as { streams?: { codec_type: string; r_frame_rate?: string }[]; format?: { duration?: string } };
  const video = j.streams?.find((s) => s.codec_type === 'video');
  return {
    duur: Number(j.format?.duration ?? 0),
    fps: video?.r_frame_rate ?? '',
    streams: (j.streams ?? []).map((s) => s.codec_type),
  };
}

async function main() {
  const map = await mkdtemp(join(tmpdir(), 'clipper-test-render-'));
  const werkmap = join(map, 'werk');
  const bron = join(werkmap, 'bron.mp4');
  try {
    // 1. Bron: 12 seconden 25 fps testbeeld met een toon die van hoogte wisselt
    //    (zodat de luidheidsmeting iets te meten heeft).
    await rm(werkmap, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(werkmap, { recursive: true });
    const gen = ff([
      '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', bron,
    ]);
    toets('testbron gegenereerd (testsrc 25fps + sinus)', gen.ok && existsSync(bron), gen.uit.slice(-200));

    console.log('framerate');
    const bronInfo = await probeBron(bron);
    toets('bron meet 25 fps', bronInfo.fps === 25, String(bronInfo.fps));
    toets('render neemt de bronframerate over', fpsVoorRender(bronInfo) === '25', fpsVoorRender(bronInfo));
    toets('onzinnige framerate valt terug op 30', fpsVoorRender({ fps: 1000, breedte: 1, hoogte: 1 }) === '30');
    toets('29.97 gaat als decimaal', fpsVoorRender({ fps: 30000 / 1001, breedte: 1, hoogte: 1 }) === '29.970');

    console.log('effectketens');
    const punch = effectKeten('punch_in', 3, { fps: '25', staand: true });
    toets('punch_in is een zoompan', Boolean(punch && punch.startsWith('zoompan=')), punch ?? 'null');
    toets('snelle_zoom is een zoompan', Boolean(effectKeten('snelle_zoom', 3, { fps: 25 })?.startsWith('zoompan=')));
    toets('op origineel kader geen zoompan', effectKeten('punch_in', 3, { staand: false }) === null);
    toets('onbekende slug geeft null', effectKeten('speed_ramp', 3) === null);

    console.log('naadbump vóór de kadercontrole');
    {
      const a: Shot = { volgorde: 1, start: 10, end: 13, functie: 'setup', focusX: 0.5, focusW: 0.15 };
      const b: Shot = { volgorde: 2, start: 13.2, end: 16, functie: 'escalatie', focusX: 0.5, focusW: 0.15 };
      const gedaanNaad = pasNaadZoomToe([a, b]);
      toets('aansluitend shot krijgt een zoombump in shot.zoom', gedaanNaad.length === 1 && b.zoom !== undefined && b.zoom > (a.zoom ?? 1), JSON.stringify(gedaanNaad));
    }

    // 2. Ondertitels: woordtijden verzinnen op de bron.
    console.log('ondertitels');
    const woorden: BronWoord[] = [];
    const tekst = 'dit is een test van de woordelijke ondertitels die in beeld komen en op het woord meelopen'.split(' ');
    tekst.forEach((w, i) => woorden.push({ w, s: 0.4 + i * 0.5, e: 0.4 + i * 0.5 + 0.35 }));
    const shots: Shot[] = [
      { volgorde: 1, start: 0.2, end: 4.2, functie: 'hook', beeld_effect: 'punch_in', sfx: 'whoosh', spanning: 3 },
      { volgorde: 2, start: 4.2, end: 7.5, functie: 'escalatie', beeld_effect: 'snelle_zoom', spanning: 6, tekstkaart: 'twee minuten later' },
      { volgorde: 3, start: 8.0, end: 11.5, functie: 'payoff', spanning: 9 },
    ];
    const opTijdlijn = woordenOpTijdlijn(shots, woorden);
    toets('woorden zijn naar de tijdlijn omgerekend', opTijdlijn.length >= 15 && opTijdlijn[0].s < 0.3, `${opTijdlijn.length} woorden, eerste op ${opTijdlijn[0]?.s}`);
    const regels = groepeerRegels(opTijdlijn);
    toets('regels van hoogstens 4 woorden', regels.every((r) => r.woorden.length <= 4 && r.woorden.length >= 1), JSON.stringify(regels.map((r) => r.woorden.length)));
    toets('regels overlappen niet', regels.every((r, i) => i === 0 || r.s >= regels[i - 1].e - 0.001));
    const ass = bouwAss(regels, { accent: '#ff8800', font: 'archivo' });
    toets('ASS heeft stijl en dialogen', /\[V4\+ Styles\]/.test(ass) && (ass.match(/^Dialogue:/gm)?.length ?? 0) === opTijdlijn.length, `${ass.match(/^Dialogue:/gm)?.length} dialogen`);
    toets('accentkleur in BGR-notatie', ass.includes('&H000088FF&'), ass.match(/&H00[0-9A-F]{6}&/)?.[0] ?? '');
    toets('ASS-tijden hebben het juiste formaat', /Dialogue: 0,0:00:0\d\.\d\d,0:00:0\d\.\d\d,Woord/.test(ass));

    const ondertitels = await maakOndertitels(shots, woorden, map, 'test', { accent: '#ff8800', font: 'archivo' });
    const libass = heeftAssFilter();
    console.log(`  (deze ffmpeg ${libass ? 'heeft' : 'heeft geen'} libass — ${libass ? 'ASS-weg' : 'PNG-terugval'} wordt getest)`);
    toets(libass ? 'ASS-bestand gemaakt' : 'PNG-overlays gemaakt', libass ? Boolean(ondertitels.assPad) : ondertitels.overlays.length === regels.length);

    // 3. De hele keten.
    console.log('maakRuweMontage');
    const hookPad = join(map, 'hook.png');
    await tekenHookKaart('Dit is de hook', hookPad, { accent: '#ff8800', font: 'archivo' });
    const kaartPad = join(map, 'kaart.png');
    await writeFile(kaartPad, await (await import('node:fs/promises')).readFile(hookPad));
    const basis = join(map, 'basis.mp4');
    const muziek = join(process.cwd(), 'assets', 'muziek', 'spanningsbed.mp3');
    const log: string[] = [];
    let fout: string | null = null;
    try {
      const uit = await maakRuweMontage({
        sourceUrl: 'lokaal://test',
        shots,
        alGesegmenteerd: true,
        outputPad: basis,
        werkmap,
        kader: 'vullend',
        overlays: [{ pad: kaartPad, start: 5.0, end: 6.5 }, ...ondertitels.overlays],
        ondertitelAss: ondertitels.assPad,
        muziekPad: existsSync(muziek) ? muziek : undefined,
        sfxMap: join(process.cwd(), 'assets', 'sfx'),
        ruisvloerDb: -60,
        maxBytes: 50 * 1024 * 1024,
        onVoortgang: (m) => log.push(m),
      });
      toets('render levert een bestand', existsSync(uit.pad));
      const p = probe(basis);
      toets('duur klopt met de som van de shots (10.8s)', Math.abs(p.duur - 10.8) < 0.3, `${p.duur}s`);
      toets('uitvoer staat op 25 fps', p.fps === '25/1', p.fps);
      toets('beeld én geluid aanwezig', p.streams.includes('video') && p.streams.includes('audio'), p.streams.join(','));
      toets('luidheid is in twee passes gemeten', !log.some((m) => /luidheidsmeting mislukt/.test(m)), log.join(' | '));
    } catch (e) {
      fout = (e as Error).message;
      toets('render slaagt', false, fout.slice(-600));
    }

    if (!fout) {
      console.log('brandOverlays (hookvarianten)');
      const variant = join(map, 'variant.mp4');
      try {
        await brandOverlays(basis, [{ pad: hookPad, start: 0, end: hookDuur('Dit is de hook') }], variant, { maxBytes: 50 * 1024 * 1024, duur: 10.8 });
        const p = probe(variant);
        toets('variant heeft dezelfde lengte', Math.abs(p.duur - 10.8) < 0.3, `${p.duur}s`);
        toets('variant heeft geluid gekopieerd', p.streams.includes('audio'));
      } catch (e) {
        toets('brandOverlays slaagt', false, (e as Error).message.slice(-300));
      }
    }
    // 4. Retentie-render: dezelfde bron, één lang shot met twee lange pauzes.
    //    De retentie-editor knipt de pauzes weg en zet kaderwissels; daarna
    //    naadbump en poort zoals in de worker, en dan de echte ffmpeg-keten.
    //    Toetst dat de delen (strakke grenzen, afwisselende zoom, re-hook-
    //    kaart) ook echt renderen en de lengte klopt.
    console.log('retentie-render');
    {
      const rw: BronWoord[] = [];
      let t = 0.3;
      for (let i = 0; i < 24; i++) {
        rw.push({ w: i % 5 === 0 ? 'eigenlijk' : `woord${i}`, s: Math.round(t * 1000) / 1000, e: Math.round((t + 0.3) * 1000) / 1000 });
        t += 0.4 + (i === 6 ? 0.9 : i === 15 ? 0.7 : 0);
      }
      const lang: Shot = {
        volgorde: 1, start: 0.2, end: Math.min(11.8, rw[rw.length - 1].e + 0.15), functie: 'setup',
        focusX: 0.5, focusW: 0.12, ankerStart: 0.3, ankerEind: rw[rw.length - 1].e, spanning: 4,
      };
      const retentie = pasRetentieToe([lang], {
        bronWoorden: rw,
        doelen: STANDAARD_DOELEN,
        kaarten: [{ start: 0, end: 1.2 }],
        ondertitels: true,
        hookTot: 1.2,
      });
      const delen = retentie.segmenten;
      toets('retentie knipt twee pauzes', retentie.ingrepen.filter((g) => g.soort === 'pauze').length === 2, retentie.logregel);
      toets('retentie maakt delen met kaderwissels', delen.length >= 3, `${delen.length} delen`);
      pasNaadZoomToe(delen);
      const na = poort(delen.map((d) => ({ ...d })), rw);
      toets('poort laat de retentiedelen staan', na.segmenten.length === delen.length && !na.ingrepen.some((g) => g.regel === 'halfFragment' || g.regel === 'overlap' || g.regel === 'ongeldig'), JSON.stringify(na.ingrepen));
      toets('keuring: geen knip in een woord', keurKnippen(na.segmenten, rw).goed === true, keurKnippen(na.segmenten, rw).detail);
      const regel = keurRetentie(retentie.na, STANDAARD_DOELEN);
      toets('keuringsregel retentie geeft een uitslag', regel.naam === 'retentie' && regel.goed !== null, regel.detail);
      const rehookPad = join(map, 'rehook.png');
      await tekenHookKaart('wacht op het bedrag', rehookPad, { accent: '#ff8800', font: 'archivo' });
      const verwacht = na.segmenten.reduce((som, d) => som + (d.end - d.start), 0);
      const uitPad = join(map, 'retentie.mp4');
      try {
        await maakRuweMontage({
          sourceUrl: 'lokaal://test',
          shots: na.segmenten,
          alGesegmenteerd: true,
          outputPad: uitPad,
          werkmap,
          kader: 'vullend',
          overlays: [{ pad: rehookPad, start: 3, end: 5 }],
          ruisvloerDb: -60,
          maxBytes: 50 * 1024 * 1024,
        });
        const p = probe(uitPad);
        toets(`retentie-render duurt de som van de delen (${verwacht.toFixed(2)}s)`, Math.abs(p.duur - verwacht) < 0.3, `${p.duur}s`);
        toets('retentie-render heeft beeld en geluid', p.streams.includes('video') && p.streams.includes('audio'));
        toets('retentie-render is korter dan het ongeknipte shot', p.duur < lang.end - lang.start - 1, `${p.duur}s vs ${(lang.end - lang.start).toFixed(2)}s`);
      } catch (e) {
        toets('retentie-render slaagt', false, (e as Error).message.slice(-600));
      }
    }
    // 5. Encode: het eindbestand op crf 17 / medium, het tussenbestand bijna
    //    verliesvrij. x264 schrijft zijn instellingen als tekst in de stroom.
    console.log('encode-instellingen');
    {
      const x264 = async (pad: string) => (await readFile(pad)).toString('latin1').match(/x264 - core[^\0]{0,2000}/)?.[0] ?? '';
      const basisOpties = await x264(basis);
      toets('eindbestand: crf 17', /crf=17\.0/.test(basisOpties), basisOpties.match(/crf=[\d.]+/)?.[0] ?? 'geen x264-info');
      toets('eindbestand: preset medium (subme=7, ref=3)', /subme=7/.test(basisOpties) && /ref=3/.test(basisOpties), basisOpties.match(/subme=\d+/)?.[0] ?? '');
      toets('eindbestand: maxrate begrensd', /vbv_maxrate=\d+/.test(basisOpties), basisOpties.match(/vbv_maxrate=\d+/)?.[0] ?? '');
      const variantPad = join(map, 'variant.mp4');
      if (existsSync(variantPad)) {
        const v = await x264(variantPad);
        toets('hookvariant: zelfde crf 17 / medium', /crf=17\.0/.test(v) && /subme=7/.test(v), v.match(/crf=[\d.]+/)?.[0] ?? '');
      }
      const tussen = join(map, 'tussen.mp4');
      await maakRuweMontage({ sourceUrl: 'lokaal://test', shots: shots.slice(0, 1), alGesegmenteerd: true, outputPad: tussen, werkmap, kader: 'vullend', tussenbestand: true });
      toets('tussenbestand: crf 12', /crf=12\.0/.test(await x264(tussen)));
    }

    // 6. Opschalen: lanczos altijd, verscherping alleen bij echt opschalen,
    //    en nooit op de blur-achtergrond.
    console.log('schaalketen');
    {
      const k720 = kaderKeten('vullend', { zoom: 1, bronHoogte: 720 });
      const k2160 = kaderKeten('vullend', { zoom: 1, bronHoogte: 2160 });
      toets('vullend schaalt met lanczos', k720.includes('flags=lanczos'), k720);
      toets('opschalen ×2,7 krijgt unsharp', k720.includes('unsharp='), k720);
      toets('neerschalen uit 2160p krijgt geen unsharp', !k2160.includes('unsharp'), k2160);
      const blur = kaderKeten('blur', { bronHoogte: 720 });
      toets('blur: voorgrond lanczos, geen unsharp', blur.includes('[fg]') && /scale=1080:-2:flags=lanczos/.test(blur) && !blur.includes('unsharp'), blur);
    }

    // 7. Graphic binnen een shot: een bron die op 6 s hard van testbeeld
    //    ("spreker") naar een effen oranje vlak ("graphic") knipt. De
    //    gezichtsdetectie is een meetstub: vóór 6 s een gezicht, erna niet.
    console.log('scènes: graphic binnen een shot');
    {
      const scenebron = join(werkmap, 'scenes.mp4');
      const gen = ff([
        '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=6',
        '-f', 'lavfi', '-i', 'color=c=0xff7a00:size=1280x720:rate=25:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
        '-map', '[v]', '-map', '2:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', scenebron,
      ]);
      toets('scènebron gegenereerd', gen.ok, gen.uit.slice(-200));
      const knippen = await detecteerSceneKnippen(scenebron, 3, 9);
      toets('bronknip op 6 s gevonden', knippen.length === 1 && Math.abs(knippen[0] - 6) < 0.1, JSON.stringify(knippen));

      const stub: GezichtMeter = async (tijden) => tijden.map((t) => t < 6);
      const shot: Shot = {
        volgorde: 1, start: 3, end: 9, functie: 'setup', focusX: 0.5, focusW: 0.12,
        gezicht: { x: 0.5, breedte: 0.12, top: 0.2, hoogte: 0.3 },
      };
      const sc = await vulScenes(scenebron, [shot], stub);
      toets('één deelstuk met gezicht, één zonder', sc.persoon === 1 && sc.graphic === 1, JSON.stringify(sc));
      const delen = deelstukken(shot, 'vullend');
      toets('spreker vullend, graphic passend (blur)', delen.length === 2 && delen[0].kader === 'vullend' && delen[1].kader === 'blur', JSON.stringify(delen));
      toets('kaderwissel precies op de bronknip', Math.abs(delen[0].tot - 3) < 0.1, JSON.stringify(delen));
      const blurClip = deelstukken(shot, 'blur');
      toets('in een blur-clip wordt het deelstuk met gezicht vullend', blurClip[0].kader === 'vullend' && blurClip[1].kader === 'blur');

      // maakRuweMontage verwacht de bron als <werkmap>/bron.mp4: een eigen
      // werkmap met de scènebron.
      const uitScene = join(map, 'scenes-render.mp4');
      const sceneWerk = join(map, 'scenewerk');
      await (await import('node:fs/promises')).mkdir(sceneWerk, { recursive: true });
      await (await import('node:fs/promises')).copyFile(scenebron, join(sceneWerk, 'bron.mp4'));
      try {
        const r = await maakRuweMontage({ sourceUrl: 'lokaal://test', shots: [shot], alGesegmenteerd: true, outputPad: uitScene, werkmap: sceneWerk, kader: 'vullend' });
        const p = probe(uitScene);
        toets('render met kaderwissel binnen het shot slaagt (6 s)', Math.abs(p.duur - 6) < 0.3, `${p.duur}s`);
        toets('kwaliteit telt 1 persoon- en 1 graphic-deelstuk', r.kwaliteit.persoonDelen === 1 && r.kwaliteit.graphicDelen === 1, JSON.stringify(r.kwaliteit));
        // Het graphic-deel staat passend: boven- en onderrand zijn de geblurde
        // oranje achtergrond, het midden het volle oranje vlak — geen zwart,
        // geen testbeeld.
        const frame = join(map, 'graphic.png');
        ff(['-ss', '4.5', '-i', uitScene, '-frames:v', '1', '-vf', 'crop=1080:40:0:900,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', frame]);
        const px = await readFile(frame);
        toets('graphic-deel toont het oranje vlak (passend, niet aangesneden testbeeld)', px[0] > 200 && px[1] > 80 && px[1] < 160 && px[2] < 60, `rgb ${px[0]},${px[1]},${px[2]}`);
      } catch (e) {
        toets('render met kaderwissel binnen het shot slaagt', false, (e as Error).message.slice(-400));
      }

      const goed = await keurGraphics([shot], 'vullend', stub);
      toets('keuring "graphics passend": goed als het graphic-deel blur is', goed.goed === true, goed.detail);
      const zonderScenes: Shot = { ...shot, start: 6.5, end: 9, scenes: undefined };
      const fout = await keurGraphics([zonderScenes], 'vullend', stub);
      toets('keuring "graphics passend": fout als een graphic vullend staat', fout.goed === false, fout.detail);
    }

    // 7b. Zachte overgang: de bron vloeit in één seconde (5,5-6,5 s) over van
    //     testbeeld naar het oranje vlak. Geen harde knip, dus scènedetectie
    //     op drempel 0,3 ziet niets — precies het geval uit de nieuwsbron
    //     ("< 3 maanden", "−39%"). De gestubde detector ziet tot 6,0 s een
    //     gezicht, met één gemist frame op 4 s (een wegkijkend hoofd).
    console.log('scènes: zachte overgang (overvloeier) en gladstrijken');
    {
      const zacht = join(map, 'zachtwerk');
      await (await import('node:fs/promises')).mkdir(zacht, { recursive: true });
      const bronZacht = join(zacht, 'bron.mp4');
      const gen = ff([
        '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=6.5',
        '-f', 'lavfi', '-i', 'color=c=0xff7a00:size=1280x720:rate=25:duration=6.5',
        '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12',
        '-filter_complex', '[0:v][1:v]xfade=transition=fade:duration=1:offset=5.5,format=yuv420p[v]',
        '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', bronZacht,
      ]);
      toets('bron met overvloeier gegenereerd', gen.ok, gen.uit.slice(-200));
      const hard = await detecteerSceneKnippen(bronZacht, 3, 9);
      toets('scènedetectie (drempel 0,3) ziet de overvloeier niet', hard.length === 0, JSON.stringify(hard));

      const zachtStub: GezichtMeter = async (tijden) => tijden.map((t) => (Math.abs(t - 4) < 0.25 ? false : t < 6));
      const shot: Shot = {
        volgorde: 1, start: 3, end: 10, functie: 'setup', focusX: 0.5, focusW: 0.12,
        gezicht: { x: 0.5, breedte: 0.12, top: 0.2, hoogte: 0.3 },
      };
      const sc = await vulScenes(bronZacht, [shot], zachtStub);
      console.log(`  (${sc.metingen} metingen, ${sc.overgangen} overgang, ${sc.ms} ms)`);
      toets('overgang gevonden zonder scèneknip: 1 persoon, 1 graphic', sc.persoon === 1 && sc.graphic === 1, JSON.stringify(sc));
      toets('gemist frame op 4 s gladgestreken (geen extra graphic)', (shot.scenes ?? []).length === 2, JSON.stringify(shot.scenes));
      const wissel = shot.scenes?.[1]?.van ?? 0;
      toets('wisselmoment binnen de overvloeier (5,5-6,5 s)', wissel >= 5.4 && wissel <= 6.6, String(wissel));
      const delen = deelstukken(shot, 'vullend');
      toets('graphic na de overvloeier passend (blur)', delen.length === 2 && delen[1].kader === 'blur', JSON.stringify(delen));
      const keur = await keurGraphics([shot], 'vullend', zachtStub);
      toets('keuring "graphics passend" groen met dezelfde meting', keur.goed === true, keur.detail);

      // Gladstrijken los: een korte run tussen twee lange gaat op in de buren.
      const runs = strijkGlad([{ van: 0, tot: 9, gezicht: true }, { van: 10, tot: 10, gezicht: false }, { van: 11, tot: 20, gezicht: true }], 0.4, 0.6);
      toets('run van 0,4 s zonder gezicht verdwijnt', runs.length === 1 && runs[0].gezicht, JSON.stringify(runs));
      const lang = strijkGlad([{ van: 0, tot: 9, gezicht: true }, { van: 10, tot: 14, gezicht: false }], 0.4, 0.6);
      toets('run van 2 s zonder gezicht blijft', lang.length === 2, JSON.stringify(lang));
    }

    console.log('fontcontrole');
    {
      const archivo = { familie: 'Archivo Black', bestand: 'ArchivoBlack-Regular.ttf' };
      toets('postscriptnaam als "pad" telt als het bedoelde font', fontKlopt(archivo, 'ArchivoBlack-Regular', 'ArchivoBlack-Regular'));
      toets('volledig pad telt ook', fontKlopt(archivo, '/home/runner/work/x/assets/fonts/ArchivoBlack-Regular.ttf', 'ArchivoBlack-Regular'));
      toets('variabel font meldt zich met familienaam', fontKlopt({ familie: 'Montserrat', bestand: 'Montserrat-Variable.ttf' }, 'Montserrat-Regular', 'Montserrat-Regular'));
      toets('een systeemfont is fout', !fontKlopt(archivo, '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'DejaVuSans'));
    }

    // 8. Ondertitelplek: onder de kin, boven de 78%-grens, nooit over het
    //    gezicht; zonder gezicht op de standaardhoogte.
    console.log('ondertitelplek');
    {
      const regelH = ondertitelMaat(null).assGrootte;
      const regels = [{ s: 0.2, e: 1.2, woorden: [{ w: 'Het', s: 0.2, e: 0.5 }, { w: 'getal', s: 0.5, e: 1.2 }] }];
      const seg = (gezicht?: Shot['gezicht'], zoom = 1.2): Shot => ({ volgorde: 1, start: 10, end: 14, functie: 'setup', focusX: 0.5, focusW: 0.12, zoom, focusY: 0.45, gezicht });
      const geen = plaatsRegels(regels, [seg(undefined)], 'vullend');
      toets('zonder gezicht: standaardhoogte (~72%)', geen.plekken[0] === 'standaard' && Math.abs(geen.plaatsing[0] - regelH / 2 - 0.72 * 1920) < 2, JSON.stringify(geen));
      // Een presentatrice in een medium close-up: kin rond 64% van het eindbeeld.
      const midden = seg({ x: 0.5, breedte: 0.12, top: 0.28, hoogte: 0.22 });
      const opBeeld = gezichtOpBeeld(midden, 'vullend', 11)!;
      const p = plaatsRegels(regels, [midden], 'vullend');
      const y = p.plaatsing[0];
      toets('ondertitel boven de 78%-grens', y <= 0.78 * 1920 + 0.5, `${y}px (${(y / 19.2).toFixed(1)}%)`);
      toets('ondertitel onder de kin (niet over het gezicht)', p.plekken[0] !== 'overlap' && (y - regelH >= opBeeld.onder * 1920 || y <= opBeeld.boven * 1920), `regel ${Math.round(y - regelH)}-${y}px, gezicht ${Math.round(opBeeld.boven * 1920)}-${Math.round(opBeeld.onder * 1920)}px (${p.plekken[0]})`);
      const closeUp = seg({ x: 0.5, breedte: 0.2, top: 0.25, hoogte: 0.5 }, 1.5);
      const pc = plaatsRegels(regels, [closeUp], 'vullend');
      toets('close-up: nooit onder 78%, en een overlap wordt benoemd of vermeden', pc.plaatsing[0] <= 0.78 * 1920 + 0.5 && ['boven_hoofd', 'overlap', 'onder_kin'].includes(pc.plekken[0]), JSON.stringify(pc));
      const graphicShot: Shot = { ...midden, scenes: [{ van: 10, tot: 14, gezicht: false }] };
      toets('graphic-deelstuk: ondertitel op de standaardhoogte', plaatsRegels(regels, [graphicShot], 'vullend').plekken[0] === 'standaard');
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
