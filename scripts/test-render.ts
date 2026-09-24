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
