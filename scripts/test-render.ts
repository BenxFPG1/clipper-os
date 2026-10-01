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
// De leestijd-toetsen gebruiken graphics van 1,3 s; de productiedrempel voor
// 'graphic is een leesmoment' (1,5 s) zou ze allemaal als overgang overslaan.
process.env.MONTAGE_GRAPHIC_MIN_VOOR_LEESTIJD ??= '1.2';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { brandHookVarianten, brandOverlays, controleerDecode, telFrames, fpsVoorRender, maakRuweMontage, pasNaadZoomToe, probeBron, type Shot } from '../src/lib/roughcut';
import { effectKeten } from '../src/lib/roughcut/kader';
import { bouwAss, groepeerRegels, heeftAssFilter, maakOndertitels, woordenOpTijdlijn } from '../src/lib/roughcut/ondertitels';
import { tekenHookKaart, hookDuur } from '../src/lib/roughcut/tekstkaarten';
import type { BronWoord } from '../src/lib/roughcut/woorden';
import { keurRetentie, pasRetentieToe } from '../src/lib/roughcut/retentie';
import { kleurCorrectie, meetKleur } from '../src/lib/roughcut/kleur';
import { poort } from '../src/lib/roughcut/poort';
import { keurKnippen } from '../src/lib/roughcut/keuring';
import { STANDAARD_DOELEN } from '../src/lib/vault/normen';
import { deelstukken, detecteerSceneKnippen, graphicWissels, strijkGlad, vulScenes, type GezichtMeter } from '../src/lib/roughcut/scenes';
import { leestijdPlan } from '../src/lib/roughcut/leestijd';
import { keurGraphics } from '../src/lib/roughcut/keuring';
import { plaatsRegels, ondertitelMaat, gezichtOpBeeld, fontKlopt, keurOndertitelPlek, legePlekTelling } from '../src/lib/roughcut/ondertitels';
import { kaderKeten } from '../src/lib/roughcut/kader';
import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { fontVoor } from '../src/lib/roughcut/tekstkaarten';
import { graphicMeterVia, inhoudKader, inhoudMeterVia, inhoudOpBeeld, inhoudsboxUitPixels } from '../src/lib/roughcut/graphics';

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
    // 3b. Hookvarianten via kop + staart: alleen de kop opnieuw encoderen,
    //     de staart één keer, en stream-copy aan elkaar. Frame-exact, en het
    //     geluid bit-voor-bit uit de basis (geen klik op de naad).
    console.log('hookvarianten: kop opnieuw, staart gedeeld');
    if (!fout) {
      const frames = (pad: string) => {
        const r = spawnSync(resolveBinary('ffprobe'), ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', pad], { encoding: 'utf8' });
        return Number((r.stdout ?? '').trim());
      };
      const grijs = (pad: string, n: number) => {
        const r = spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-i', pad, '-vf', `select=eq(n\\,${n}),scale=64:36`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1e7 });
        return r.stdout as Buffer;
      };
      const d = (a: Buffer, b: Buffer) => (a.length && a.length === b.length ? a.reduce((t, x, i) => t + Math.abs(x - b[i]), 0) / a.length : 255);
      const pcm = (pad: string) => spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-i', pad, '-map', '0:a', '-f', 's16le', '-ac', '1', '-'], { maxBuffer: 1e8 }).stdout as Buffer;
      const uitA = join(map, 'var-a.mp4');
      const uitB = join(map, 'var-b.mp4');
      const t0 = Date.now();
      const r = await brandHookVarianten(basis, [{ hookPad, eind: 2.4, uitPad: uitA }, { hookPad, eind: 3.1, uitPad: uitB }], { duur: 10.8, werkmap: map, maxBytes: 50 * 1024 * 1024 });
      const nieuwMs = Date.now() - t0;
      const t1 = Date.now();
      for (const [i, eind] of [2.4, 3.1].entries()) await brandOverlays(basis, [{ pad: hookPad, start: 0, end: eind }], join(map, `oud-${i}.mp4`), { maxBytes: 50 * 1024 * 1024, duur: 10.8 });
      const oudMs = Date.now() - t1;
      console.log(`  (twee varianten: oude manier ${(oudMs / 1000).toFixed(1)} s, kop+staart ${(nieuwMs / 1000).toFixed(1)} s; kop tot ${r.kopTot.toFixed(3)} s)`);
      toets('kop + staart gebruikt', r.manier === 'concat');
      const nb = frames(basis);
      toets('variant heeft exact evenveel frames als de basis', frames(uitA) === nb && frames(uitB) === nb, `${frames(uitA)}/${frames(uitB)} vs ${nb}`);
      const fps = 25;
      const naad = Math.round(r.kopTot * fps);
      let naadGoed = true;
      let detail = '';
      for (const n of [naad - 2, naad - 1, naad, naad + 1, naad + 2]) {
        const eigen = d(grijs(uitA, n), grijs(basis, n));
        const buur = d(grijs(uitA, n), grijs(basis, n + 1));
        detail += `${n}: ${eigen.toFixed(1)}/${buur.toFixed(1)} `;
        // Na de hookkaart moet elk frame op zijn eigen frame in de basis lijken.
        if (n >= naad && !(eigen < 3 && eigen < buur)) naadGoed = false;
      }
      toets('rond de naad frame-exact (geen dubbel of verloren frame)', naadGoed, detail);
      const pa = pcm(uitA);
      const pb = pcm(basis);
      toets('geluid bit-identiek aan de basis (geen klik op de naad)', pa.length === pb.length && pa.equals(pb), `${pa.length} vs ${pb.length}`);
      // Sinds het veiligheidsnet (SPS/PPS-vergelijking + volledige decode-
      // controle per variant) is het voordeel op een testclip van 10 s klein;
      // op een echte clip van 30–60 s blijft het groot. Niet trager dan de
      // oude manier, met wat ruis-marge.
      toets('niet trager dan de oude manier (±15%)', nieuwMs < oudMs * 1.15, `${nieuwMs} vs ${oudMs} ms`);
      toets('decode-controle: beide varianten goed, niets teruggevallen', r.teruggevallen.length === 0, JSON.stringify(r.teruggevallen));
      const cA = await controleerDecode(uitA, await telFrames(basis));
      toets('controleerDecode: variant decodeert foutloos met het frameaantal van de basis', cA.goed && cA.frames === nb, `${cA.reden} (${cA.frames})`);

      // Veiligheidsnet: een staart met een andere maxrate/bufsize (zoals
      // wanneer die van de stuklengte zou afhangen) onder de header van de
      // kop. ffmpeg zelf decodeert dat vaak nog; de SPS/PPS-vergelijking
      // vangt het vóór de concat.
      const uitC = join(map, 'var-c.mp4');
      const rc = await brandHookVarianten(basis, [{ hookPad, eind: 2.4, uitPad: uitC }], {
        duur: 10.8,
        werkmap: map,
        maxBytes: 50 * 1024 * 1024,
        staartEncode: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-maxrate', '900000', '-bufsize', '1800000'],
      });
      toets('staart met andere maxrate: gevangen en volledig opnieuw ge-encodeerd', rc.teruggevallen.length === 1 && /SPS\/PPS/.test(rc.teruggevallen[0].reden), JSON.stringify(rc.teruggevallen));
      const cC = await controleerDecode(uitC, nb);
      toets('na de terugval decodeert de variant foutloos', cC.goed, cC.reden);
      // Een afgekapt bestand (zoals een halve download) wordt ook gezien.
      const { readFile: lees, writeFile: schrijf } = await import('node:fs/promises');
      const heel = await lees(uitA);
      const kapot = join(map, 'afgekapt.mp4');
      await schrijf(kapot, heel.subarray(0, Math.floor(heel.length * 0.7)));
      const cK = await controleerDecode(kapot, nb);
      toets('afgekapt bestand: decode-controle keurt af', !cK.goed, cK.reden);
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
    // 4b. Afwerking: alle nieuwe filters in één render — kleurcorrectie (eq),
    //     stemketen, easing-zooms, kaderwissel-push, hit op het payoff-woord,
    //     J/L-naad, pauze-crossfade, sfx-plan op vaste momenten, muziek met
    //     aanzet na de hook en pop-ondertitels.
    console.log('afwerking-render');
    {
      const muziekTrack = join(map, 'track.mp3');
      ff(['-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.5),0.03),0.5*sin(2*PI*1000*t),0)+0.08*sin(2*PI*110*t)':s=44100:d=6", '-c:a', 'libmp3lame', muziekTrack]);
      const kleur = kleurCorrectie(await meetKleur(bron, [1, 5, 9]));
      toets('kleur gemeten op de bron', kleur.filter !== null && kleur.detail.startsWith('helderheid'), kleur.detail);
      const af: Shot[] = [
        { volgorde: 1, start: 0.2, end: 3.0, functie: 'hook', beeld_effect: 'punch_in' },
        { volgorde: 2, start: 3.0, end: 4.6, functie: 'context', zoom: 1.15, zachteWissel: true },
        { volgorde: 3, start: 5.0, end: 7.0, functie: 'escalatie', strakBegin: true, audioNaad: 0.2 },
        { volgorde: 4, start: 8.0, end: 11.0, functie: 'payoff', hit: 0.3 },
      ];
      const plan = [
        { slug: 'whoosh', t: 2.68, reden: 'kaderwissel' },
        { slug: 'riser', t: 4.9, volume: 0.13, reden: 'opbouw' },
        { slug: 'impact', t: 6.38, volume: 0.2, reden: 'payoff-woord' },
        { slug: 'ding', t: 8.0, reden: 'kaart met getal' },
      ];
      const afWoorden: BronWoord[] = 'de afwerking maakt het af met een pop op elk woord'.split(' ').map((w, i) => ({ w, s: 0.4 + i * 0.5, e: 0.4 + i * 0.5 + 0.35 }));
      const afOndertitels = await maakOndertitels(af, afWoorden, map, 'afwerking', { accent: '#ff8800', font: 'archivo', ondertitel_stijl: 'pop' });
      const afPad = join(map, 'afwerking.mp4');
      const afLog: string[] = [];
      const verwacht = af.reduce((t, x) => t + (x.end - x.start), 0);
      try {
        await maakRuweMontage({
          sourceUrl: 'lokaal://test',
          shots: af,
          alGesegmenteerd: true,
          outputPad: afPad,
          werkmap,
          kader: 'vullend',
          overlays: afOndertitels.overlays,
          ondertitelAss: afOndertitels.assPad,
          muziekPad: muziekTrack,
          sfxMap: join(process.cwd(), 'assets', 'sfx'),
          ruisvloerDb: -60,
          maxBytes: 50 * 1024 * 1024,
          afwerking: { easing: true, kleurFilter: kleur.filter, stem: true, sfxPlan: plan, muziekNaHook: 1.2 },
          onVoortgang: (m) => afLog.push(m),
        });
        const p = probe(afPad);
        toets(`afwerking-render duurt de som van de shots (${verwacht.toFixed(1)}s)`, Math.abs(p.duur - verwacht) < 0.3, `${p.duur}s`);
        toets('afwerking-render heeft beeld en geluid', p.streams.includes('video') && p.streams.includes('audio'));
        toets('luidheid in twee passes gemeten', !afLog.some((m) => /luidheidsmeting mislukt/.test(m)), afLog.join(' | '));
      } catch (e) {
        toets('afwerking-render slaagt', false, (e as Error).message.slice(-900));
      }

      // Naad met pauze-crossfade: de bron is een doorlopende sinus; een harde
      // knip midden in de golf (0,37 s verder) is een klik. Gemeten als de
      // grootste knik (tweede verschil tussen samples) rond de naad, t.o.v.
      // een rustig stuk van dezelfde render. Ter controle: met een fade van
      // 1 ms (MONTAGE_PAUZE_CROSSFADE=0.001) is de knik ~6× zo groot.
      const naadPad = join(map, 'naad.mp4');
      try {
        await maakRuweMontage({
          sourceUrl: 'lokaal://test',
          shots: [
            { volgorde: 1, start: 0.2, end: 3.0, functie: 'setup' },
            { volgorde: 2, start: 3.37, end: 6.0, functie: 'setup', strakBegin: true },
          ],
          alGesegmenteerd: true,
          outputPad: naadPad,
          werkmap,
          kader: 'vullend',
          ruisvloerDb: -60,
          maxBytes: 50 * 1024 * 1024,
          afwerking: { stem: true },
        });
        const r = spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-i', naadPad, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1e9 });
        const b = r.stdout as Buffer;
        const x = new Float32Array(Math.floor(b.length / 4));
        for (let i = 0; i < x.length; i++) x[i] = b.readFloatLE(i * 4);
        const sprong = (van: number, tot: number) => {
          let m = 0;
          for (let i = Math.max(1, Math.floor(van * 48000)); i < Math.min(x.length - 1, tot * 48000); i++) m = Math.max(m, Math.abs(x[i + 1] - 2 * x[i] + x[i - 1]));
          return m;
        };
        const rustig = sprong(1.0, 2.2);
        const naad = sprong(2.65, 2.95);
        console.log(`    grootste knik in de golf: rustig ${rustig.toFixed(4)}, rond de naad ${naad.toFixed(4)}`);
        toets('naad met crossfade klikt niet (knik ≤ 2× een rustig stuk)', rustig > 0 && naad <= rustig * 2, `${naad.toFixed(4)} vs ${rustig.toFixed(4)}`);
      } catch (e) {
        toets('naad-render slaagt', false, (e as Error).message.slice(-600));
      }
    }
    // 4c. Scherp begin: de eerste 0,4 s bevroren op het frame van 0,4 s in
    //     het shot; daarna loopt het beeld door, de lengte blijft gelijk.
    console.log('scherp begin: bevroren begin');
    {
      const uitPad = join(map, 'bevries.mp4');
      const bevrShots: Shot[] = [
        { volgorde: 1, start: 1.0, end: 4.0, functie: 'hook', bevriesBegin: { tot: 0.4, bron: 1.4 } },
        { volgorde: 2, start: 5.0, end: 7.0, functie: 'setup' },
      ];
      const log: string[] = [];
      try {
        await maakRuweMontage({ sourceUrl: 'lokaal://test', shots: bevrShots, alGesegmenteerd: true, outputPad: uitPad, werkmap, kader: 'vullend', ruisvloerDb: -60, maxBytes: 50 * 1024 * 1024, onVoortgang: (m) => log.push(m) });
        const p = probe(uitPad);
        toets('lengte ongewijzigd (5,0 s)', Math.abs(p.duur - 5.0) < 0.15, `${p.duur}s`);
        toets('logregel "scherp begin: eerste 0.40 s bevroren"', log.some((m) => /scherp begin: eerste 0\.40 s bevroren op bron 1\.40 s/.test(m)), log.join(' | '));
        const grijsN = (n: number) => spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-i', uitPad, '-vf', `select=eq(n\\,${n}),scale=64:36`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1e7 }).stdout as Buffer;
        const dd = (a: Buffer, b: Buffer) => (a.length && a.length === b.length ? a.reduce((t, x, i) => t + Math.abs(x - b[i]), 0) / a.length : 255);
        const f0 = grijsN(0);
        const f8 = grijsN(8);
        const f10 = grijsN(10);
        const f20 = grijsN(20);
        toets('eerste 0,4 s stilstaand (frame 0 = frame 8)', dd(f0, f8) < 1, dd(f0, f8).toFixed(2));
        toets('daarna loopt het beeld zonder sprong door (frame 10 lijkt op het bevroren frame)', dd(f8, f10) < 6, dd(f8, f10).toFixed(2));
        toets('en beweegt het weer (frame 20 ≠ frame 0)', dd(f0, f20) > 1, dd(f0, f20).toFixed(2));
      } catch (e) {
        toets('render met bevroren begin slaagt', false, (e as Error).message.slice(-500));
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

    // 9. Slimme inzoom op een graphic: een oranje vlak met een groot getal in
    //    het midden en een kleine bronregel linksonder. De inhoudsbox moet de
    //    bronregel meenemen, de inzoom moet groter zijn dan passend, en er mag
    //    niets wegvallen.
    console.log('graphics: inzoomen op de inhoud');
    {
      fontVoor(null); // fonts registreren
      const doek = createCanvas(1280, 720);
      const ctx = doek.getContext('2d');
      ctx.fillStyle = '#ff7a00';
      ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = '#ffffff';
      ctx.font = '160px "Archivo Black"';
      ctx.textAlign = 'center';
      ctx.fillText('-39%', 640, 420);
      ctx.font = '22px "Archivo Black"';
      ctx.textAlign = 'left';
      ctx.fillText('BRON: CBS', 40, 690);
      const png = join(map, 'graphic.png');
      await (await import('node:fs/promises')).writeFile(png, doek.toBuffer('image/png'));
      const gwerk = join(map, 'graphicwerk');
      await (await import('node:fs/promises')).mkdir(gwerk, { recursive: true });
      const gbron = join(gwerk, 'bron.mp4');
      const gen = ff(['-loop', '1', '-i', png, '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-t', '4', '-r', '25',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', gbron]);
      toets('graphic-bron gegenereerd', gen.ok, gen.uit.slice(-200));

      const box = await inhoudMeterVia(gbron)([0.5, 2, 3.5]);
      toets('inhoudsbox gemeten', box !== null, 'null');
      if (box) {
        toets('box omvat de bronregel linksonder', box.x0 <= 40 / 1280 + 0.01 && box.y1 >= 685 / 720 - 0.02, JSON.stringify(box));
        toets('box omvat het grote getal', box.x1 >= 0.62 && box.y0 <= 0.45, JSON.stringify(box));
        const k = inhoudKader(box);
        toets('kadrering bevat de hele inhoud (niets valt weg)', k.r.x0 <= box.x0 && k.r.y0 <= box.y0 && k.r.x1 >= box.x1 && k.r.y1 >= box.y1, JSON.stringify(k));
        const passendHoogte = (box.y1 - box.y0) * 1080 * (9 / 16);
        const ingezoomd = ((box.y1 - box.y0) / (k.r.y1 - k.r.y0)) * k.fgH;
        toets('inhoud groter dan passend', ingezoomd > passendHoogte * 1.05, `${Math.round(ingezoomd)} px vs ${Math.round(passendHoogte)} px`);

        const shot: Shot = { volgorde: 1, start: 0.2, end: 3.8, functie: 'setup', scenes: [{ van: 0, tot: 4, gezicht: false, inhoud: box }] };
        const uit = join(map, 'graphic-render.mp4');
        try {
          const r = await maakRuweMontage({ sourceUrl: 'lokaal://test', shots: [shot], alGesegmenteerd: true, outputPad: uit, werkmap: gwerk, kader: 'vullend' });
          toets('render met ingezoomde graphic slaagt', existsSync(uit) && r.kwaliteit.graphicsIngezoomd === 1, JSON.stringify(r.kwaliteit));
          // De bronregel (wit op oranje) moet in het eindbeeld staan, op de
          // plek die de geometrie voorspelt.
          const frame = join(map, 'graphic-eind.raw');
          ff(['-ss', '1.5', '-i', uit, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', frame]);
          const px = await readFile(frame);
          const naarUit = (bx: number, by: number) => ({
            x: Math.round((1080 - k.fgB) / 2 + ((bx - k.r.x0) / (k.r.x1 - k.r.x0)) * k.fgB),
            y: Math.round(k.y0 + ((by - k.r.y0) / (k.r.y1 - k.r.y0)) * k.fgH),
          });
          const lo = naarUit(40 / 1280, 670 / 720);
          const hi = naarUit(200 / 1280, 692 / 720);
          let wit = 0;
          for (let y = lo.y; y <= hi.y; y++) for (let x = lo.x; x <= hi.x; x++) {
            const i = (y * 1080 + x) * 3;
            if (px[i] > 220 && px[i + 1] > 220 && px[i + 2] > 220) wit++;
          }
          toets('bronregel staat in het eindbeeld (niet weggesneden)', wit > 20, `${wit} witte pixels in ${lo.x},${lo.y}-${hi.x},${hi.y}`);
        } catch (e) {
          toets('render met ingezoomde graphic slaagt', false, (e as Error).message.slice(-400));
        }

        const stubGeen: GezichtMeter = async (t) => t.map(() => false);
        const keurGoed = await keurGraphics([shot], 'vullend', stubGeen, graphicMeterVia(gbron));
        toets('keuring: ingezoomde graphic binnen beeld', keurGoed.goed === true, keurGoed.detail);
        // Te krap gemeten (alleen het getal): de hermeting vindt de bronregel
        // buiten het gerenderde gebied → fout.
        const krap: Shot = { ...shot, scenes: [{ van: 0, tot: 4, gezicht: false, inhoud: { x0: 0.3, y0: 0.35, x1: 0.7, y1: 0.6 } }] };
        const keurFout = await keurGraphics([krap], 'vullend', stubGeen, graphicMeterVia(gbron));
        toets('keuring: inhoud buiten beeld → fout', keurFout.goed === false && /buiten beeld/.test(keurFout.detail), keurFout.detail);

        const plek = plaatsRegels([{ s: 1, e: 2, woorden: [{ w: 'min', s: 1, e: 1.4 }, { w: 'negenendertig', s: 1.4, e: 2 }] }], [shot], 'vullend');
        const inhoudY = inhoudOpBeeld(box);
        const y = plek.plaatsing[0];
        const hoogte = ondertitelMaat(null).assGrootte;
        toets('ondertitel valt niet over de graphic-inhoud', y - hoogte >= inhoudY.onder * 1920 || y <= inhoudY.boven * 1920, `regel ${y - hoogte}-${y}, inhoud ${Math.round(inhoudY.boven * 1920)}-${Math.round(inhoudY.onder * 1920)} (${plek.plekken[0]})`);
      }

      // Geen egale achtergrond (ruis over het hele vlak): geen box, dus passend.
      const ruis = Buffer.alloc(480 * 270 * 3);
      for (let i = 0; i < ruis.length; i++) ruis[i] = (i * 7919) % 251;
      toets('druk beeld zonder egale achtergrond → geen inzoom', inhoudsboxUitPixels(ruis, 480, 270) === null);
    }

    // 10. Leestijd: shot A eindigt op een graphic van 1,3 s (bronknip naar
    //     oranje op 6 s), shot B is spreker. De graphic blijft 0,9 s staan
    //     over het begin van B; het geluid loopt gewoon door.
    console.log('leestijd: graphic vasthouden over het volgende shot');
    {
      const sceneWerk = join(map, 'scenewerk');
      if (existsSync(join(sceneWerk, 'bron.mp4'))) {
        const a: Shot = {
          volgorde: 1, start: 4, end: 7.3, functie: 'setup', focusX: 0.5, focusW: 0.12,
          scenes: [{ van: 4, tot: 6, gezicht: true }, { van: 6, tot: 7.3, gezicht: false, leeswoorden: 4, bevries: 7.2 }],
        };
        const b: Shot = { volgorde: 2, start: 2, end: 4, functie: 'escalatie', focusX: 0.5, focusW: 0.12 };
        const uitLees = join(map, 'leestijd.mp4');
        try {
          const r = await maakRuweMontage({ sourceUrl: 'lokaal://test', shots: [a, b], alGesegmenteerd: true, outputPad: uitLees, werkmap: sceneWerk, kader: 'vullend' });
          const p = probe(uitLees);
          toets('lengte blijft de som van de shots (5,3 s)', Math.abs(p.duur - 5.3) < 0.2, `${p.duur}s`);
          toets('logregel meldt de verlenging', /1 verlengd/.test(r.kwaliteit.leestijd ?? ''), r.kwaliteit.leestijd ?? '');
          const kleur = async (t: number) => {
            const f = join(map, `lees-${t}.raw`);
            ff(['-ss', t.toFixed(2), '-i', uitLees, '-frames:v', '1', '-vf', 'crop=1080:40:0:940,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', f]);
            const px = await readFile(f);
            return [px[0], px[1], px[2]];
          };
          const oranje = (c: number[]) => c[0] > 200 && c[1] > 80 && c[1] < 160 && c[2] < 60;
          const inHold = await kleur(3.3 + 0.5);
          const naHold = await kleur(3.3 + 1.5);
          toets('0,5 s in shot B staat de graphic nog (vastgehouden)', oranje(inHold), `rgb ${inHold}`);
          toets('na de vasthoudtijd is shot B weer de spreker', !oranje(naHold), `rgb ${naHold}`);
        } catch (e) {
          toets('render met leestijd slaagt', false, (e as Error).message.slice(-400));
        }
      }
    }

    // 11. Vasthouden met een frame van ín de graphic: de bron gaat van oranje
    //     (graphic) naar testbeeld (spreker) op 4 s, maar het graphic-deelstuk
    //     loopt tot 4,5 s. Het laatste frame is dus al de spreker; vastgehouden
    //     moet het oranje worden (bevries = 3,0 s), geen bevroren spreker.
    console.log('leestijd: vastgehouden frame komt uit de graphic');
    {
      const holdWerk = join(map, 'holdwerk');
      await (await import('node:fs/promises')).mkdir(holdWerk, { recursive: true });
      const holdBron = join(holdWerk, 'bron.mp4');
      const gen = ff([
        '-f', 'lavfi', '-i', 'color=c=0xff7a00:size=1280x720:rate=25:duration=4',
        '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=220:duration=10',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', holdBron,
      ]);
      toets('bron oranje → testbeeld gegenereerd', gen.ok, gen.uit.slice(-200));
      const a: Shot = { volgorde: 1, start: 2, end: 4.5, functie: 'setup', focusX: 0.5, focusW: 0.12, scenes: [{ van: 2, tot: 4.5, gezicht: false, leeswoorden: 8, bevries: 3.0 }] };
      const b: Shot = { volgorde: 2, start: 6, end: 9, functie: 'escalatie', focusX: 0.5, focusW: 0.12 };
      const uitHold = join(map, 'hold.mp4');
      try {
        await maakRuweMontage({ sourceUrl: 'lokaal://test', shots: [a, b], alGesegmenteerd: true, outputPad: uitHold, werkmap: holdWerk, kader: 'vullend' });
        const p = probe(uitHold);
        toets('lengte = som van de shots (5,5 s)', Math.abs(p.duur - 5.5) < 0.2, `${p.duur}s`);
        const f = join(map, 'hold.raw');
        ff(['-ss', '2.9', '-i', uitHold, '-frames:v', '1', '-vf', 'crop=1080:40:0:940,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', f]);
        const px = await readFile(f);
        toets('tijdens het vasthouden staat de graphic (oranje), niet de spreker', px[0] > 200 && px[1] > 80 && px[1] < 160 && px[2] < 60, `rgb ${px[0]},${px[1]},${px[2]}`);
      } catch (e) {
        toets('render met vasthoudframe slaagt', false, (e as Error).message.slice(-400));
      }
    }

    // 12. Drie graphics direct na elkaar (elk 1,8 s, veel tekst) en dan een
    //     spreker. Het blok leent van de spreker: elke graphic blijft langer
    //     staan, de latere komen later in beeld, de spreker levert de som in.
    console.log('leestijd: blok van drie graphics, dan de spreker');
    {
      const blokWerk = join(map, 'blokwerk');
      const fsp = await import('node:fs/promises');
      await fsp.mkdir(blokWerk, { recursive: true });
      fontVoor(null);
      const kleuren = ['#1f4e9e', '#1e7a3a', '#8a1f7a'];
      const delen: string[] = [];
      for (const [i, kleur] of kleuren.entries()) {
        const doek = createCanvas(1280, 720);
        const c = doek.getContext('2d');
        c.fillStyle = kleur;
        c.fillRect(0, 0, 1280, 720);
        c.fillStyle = '#ffffff';
        c.font = '44px "Archivo Black"';
        c.textAlign = 'center';
        for (let r = 0; r < 5; r++) c.fillText(`REGEL ${r + 1} VAN GRAPHIC ${i + 1} MET TEKST`, 640, 200 + r * 80);
        const png = join(blokWerk, `g${i}.png`);
        await fsp.writeFile(png, doek.toBuffer('image/png'));
        const mp4 = join(blokWerk, `g${i}.mp4`);
        ff(['-loop', '1', '-i', png, '-t', '1.8', '-r', '25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', mp4]);
        delen.push(mp4);
      }
      const spreker = join(blokWerk, 'spreker.mp4');
      ff(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', spreker]);
      const blokBron = join(blokWerk, 'bron.mp4');
      const gen = ff([
        ...[...delen, spreker].flatMap((d) => ['-i', d]),
        '-f', 'lavfi', '-i', 'sine=frequency=220:duration=11.4',
        '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]', '-map', '[v]', '-map', '4:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', blokBron,
      ]);
      toets('bron met drie graphics + spreker gegenereerd', gen.ok, gen.uit.slice(-200));
      const wissels = await graphicWissels(blokBron, 0, 5.4);
      toets('graphic-wissels op 1,8 en 3,6 s gevonden', wissels.length === 2 && Math.abs(wissels[0] - 1.8) < 0.1 && Math.abs(wissels[1] - 3.6) < 0.1, JSON.stringify(wissels));
      const shot: Shot = { volgorde: 1, start: 0, end: 11.4, functie: 'setup', focusX: 0.5, focusW: 0.12 };
      const sc = await vulScenes(blokBron, [shot], async (t) => t.map((x) => x >= 5.4));
      toets('drie graphic-scènes en één spreker-scène', (shot.scenes ?? []).filter((x) => x.gezicht === false).length === 3 && sc.graphicSplitsingen === 2, JSON.stringify({ sc, scenes: shot.scenes }));
      const plan = leestijdPlan([shot], 'vullend');
      toets('blok van drie, alle drie verlengd', plan.graphics.length === 3 && plan.graphics.every((g) => g.blok === 3 && g.vasthouden > 0), JSON.stringify(plan.graphics.map((g) => [g.duur, g.nodig, g.vasthouden, g.woorden])));
      const uitBlok = join(map, 'blok.mp4');
      try {
        await maakRuweMontage({ sourceUrl: 'lokaal://test', shots: [shot], alGesegmenteerd: true, outputPad: uitBlok, werkmap: blokWerk, kader: 'vullend' });
        const p = probe(uitBlok);
        toets('lengte blijft 11,4 s (geluid ongewijzigd)', Math.abs(p.duur - 11.4) < 0.2, `${p.duur}s`);
        const kleurOp = async (t: number) => {
          const f = join(map, `blok-${t}.raw`);
          ff(['-ss', t.toFixed(2), '-i', uitBlok, '-frames:v', '1', '-vf', 'crop=40:40:1020:950,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', f]);
          const px = await readFile(f);
          return [px[0], px[1], px[2]];
        };
        const g2 = plan.graphics[1];
        const t2 = g2.beeldStart + 0.2;
        const kleurG2 = await kleurOp(t2);
        // Op t2 staat in de bron al graphic 3 (paars) als t2 > 3,6; in beeld hoort nog graphic 2 (groen).
        toets(`graphic 2 is opgeschoven: op ${t2.toFixed(1)} s groen in beeld`, kleurG2[1] > kleurG2[0] && kleurG2[1] > kleurG2[2], `rgb ${kleurG2}`);
        const eindBlok = plan.graphics[2].beeldStart + plan.graphics[2].getoond;
        const na = await kleurOp(eindBlok + 0.5);
        toets('na het blok weer de spreker (geen graphickleur)', !(na[1] > na[0] + 30 && na[1] > na[2] + 30) && !(na[2] > na[1] + 30 && na[0] > na[1] + 30), `rgb ${na}`);
      } catch (e) {
        toets('render van het blok slaagt', false, (e as Error).message.slice(-400));
      }
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
      toets('close-up: nooit onder de noodgrens (80%), en een overlap wordt benoemd of vermeden', pc.plaatsing[0] <= 0.8 * 1920 + 0.5 && ['boven_hoofd', 'overlap', 'onder_kin', 'lager', 'kleiner', 'zoom_terug'].includes(pc.plekken[0]), JSON.stringify(pc));
      // De nieuwe volgorde: onder de kin → lager (tot 80%) → kleiner →
      // punch-in terug → pas dan boven het hoofd.
      const vlak = (top: number, hoogte: number, zoom: number): Shot => ({ volgorde: 1, start: 10, end: 14, functie: 'setup', focusX: 0.5, zoom, focusY: 0.5, gezicht: { x: 0.5, breedte: 0.12, top, hoogte } });
      const plek = (sg: Shot) => plaatsRegels(regels, [sg], 'vullend');
      const lager = plek(vlak(0.3, 0.41, 1));
      toets('kin net te laag: iets lager geplaatst (≤ 80%)', lager.plekken[0] === 'lager' && lager.plaatsing[0] <= 0.8 * 1920, JSON.stringify(lager));
      const klein = plek(vlak(0.3, 0.425, 1));
      toets('ook dat niet: de regel kleiner (85%)', klein.plekken[0] === 'kleiner' && klein.schalen[0] === 0.85, JSON.stringify(klein));
      const punch = vlak(0.3, 0.39, 1.3);
      const zt = plek(punch);
      toets('met punch-in: zoom terug zodat de regel onder de kin past', zt.plekken[0] === 'zoom_terug' && (punch.zoom ?? 9) < 1.3 && (punch.zoom ?? 0) >= 1, JSON.stringify({ zt, zoom: punch.zoom }));
      const hoofd = plek(vlak(0.45, 0.31, 1));
      toets('zonder punch-in en zonder ruimte: pas dan boven het hoofd', hoofd.plekken[0] === 'boven_hoofd', JSON.stringify(hoofd));
      toets('keuring "ondertitel over gezicht" groen zonder overlap', keurOndertitelPlek({ ...legePlekTelling(), onder_kin: 3, lager: 1, boven_hoofd: 1 }).goed === true);
      toets('en rood bij een regel over het gezicht', keurOndertitelPlek({ ...legePlekTelling(), overlap: 1 }).goed === false);
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
