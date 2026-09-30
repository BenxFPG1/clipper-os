/**
 * Tests voor de afwerking (look, energie, natuurlijke knippen): de
 * ondertitelpresets (ASS-tekst; lokaal is er geen libass), easing- en
 * hit-zooms, kleurcorrectie zonder clippen, de stemketen (LUFS en geen
 * pompen), het sound-designplan, J/L-naden, adem in de pauzeknippen en
 * muziektracks met beats. Met ffmpeg op synthetische bronnen, zonder
 * netwerk of model.
 *
 * Draaien: npm run test:afwerking
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { stemKeten, type Shot } from '../src/lib/roughcut';
import { effectKeten } from '../src/lib/roughcut/kader';
import { bouwAss, groepeerRegels, woordenOpTijdlijn } from '../src/lib/roughcut/ondertitels';
import { kleurCorrectie, meetKleur } from '../src/lib/roughcut/kleur';
import { payoffMoment, planJL, planSfx, zetHit } from '../src/lib/roughcut/sounddesign';
import { analyseerBeats, beatsOpTijdlijn, BEAT_MIN_ZEKERHEID, kiesTrack, knipOpBeat, tracksVoor } from '../src/lib/roughcut/muziektracks';
import { afwerkingAan, afwerkingOverzicht } from '../src/lib/roughcut/afwerking';
import { pasRetentieToe, spreekTempo } from '../src/lib/roughcut/retentie';
import { instelling } from '../src/lib/roughcut/instellingen';
import { STANDAARD_DOELEN } from '../src/lib/vault/normen';
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

function ff(args: string[]): { ok: boolean; uit: string; buf: Buffer } {
  const r = spawnSync(resolveBinary('ffmpeg'), ['-hide_banner', '-nostdin', '-y', ...args], { maxBuffer: 1e9 });
  return { ok: r.status === 0, uit: `${r.stderr ?? ''}`, buf: (r.stdout as Buffer) ?? Buffer.alloc(0) };
}

/** Mono float-samples (48 kHz) van een bestand. */
function pcm(pad: string, extra: string[] = []): Float32Array {
  const r = ff(['-v', 'error', '-i', pad, ...extra, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
  const f = new Float32Array(Math.floor(r.buf.length / 4));
  for (let i = 0; i < f.length; i++) f[i] = r.buf.readFloatLE(i * 4);
  return f;
}

function lufs(pad: string, filter: string): number {
  const r = ff(['-i', pad, '-af', `${filter}${filter ? ',' : ''}ebur128`, '-f', 'null', '-']);
  const m = r.uit.match(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS/);
  return m ? Number(m[1]) : NaN;
}

/** Zoals de render: loudnorm in twee passes (meten, dan lineair toepassen), daarna gemeten. */
function lufsTweePass(pad: string, keten: string): number {
  const LOUD = 'I=-14:TP=-1.5:LRA=9';
  const meet = ff(['-i', pad, '-af', `${keten},loudnorm=${LOUD}:print_format=json`, '-f', 'null', '-']);
  const j = JSON.parse(meet.uit.slice(meet.uit.lastIndexOf('{'), meet.uit.lastIndexOf('}') + 1)) as Record<string, string>;
  return lufs(
    pad,
    `${keten},loudnorm=${LOUD}:measured_I=${j.input_i}:measured_LRA=${j.input_lra}:measured_TP=${j.input_tp}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,alimiter=limit=0.86:level=disabled`,
  );
}

function spraak(van: number, aantal: number, opties: { woord?: number; gat?: number; pauzes?: Record<number, number>; tekst?: (i: number) => string } = {}): BronWoord[] {
  const woord = opties.woord ?? 0.3;
  const gat = opties.gat ?? 0.1;
  const uit: BronWoord[] = [];
  let t = van;
  for (let i = 0; i < aantal; i++) {
    uit.push({ w: opties.tekst ? opties.tekst(i) : `woord${i}`, s: Math.round(t * 1000) / 1000, e: Math.round((t + woord) * 1000) / 1000 });
    t += woord + gat + (opties.pauzes?.[i] ?? 0);
  }
  return uit;
}

const shot = (volgorde: number, start: number, end: number, extra: Partial<Shot> = {}): Shot => ({
  volgorde,
  start,
  end,
  functie: 'setup',
  focusX: 0.5,
  focusW: 0.12,
  ...extra,
});

async function main() {
  const map = await mkdtemp(join(tmpdir(), 'clipper-test-afwerking-'));
  try {
    // -----------------------------------------------------------------------
    console.log('aan/uit per onderdeel');
    {
      toets('standaard aan', afwerkingAan('easing', null) && afwerkingAan('sfx', { afwerking: {} }));
      toets('huisstijl zet een onderdeel uit', !afwerkingAan('sfx', { afwerking: { sfx: false } }) && afwerkingAan('easing', { afwerking: { sfx: false } }));
      // Instellingen worden per run gecachet: de env moet vóór de eerste
      // lezing van AFWERKING_KLEUR staan (en blijft daarna voor deze run).
      process.env.MONTAGE_AFWERKING_KLEUR = '0';
      toets('MONTAGE_AFWERKING_KLEUR=0 zet kleur uit', !afwerkingAan('kleur', null));
      toets('overzicht voor de log', /^easing aan, hit aan, kleur uit, stem aan, sfx uit, muziek aan, jl aan$/.test(afwerkingOverzicht({ afwerking: { sfx: false } })), afwerkingOverzicht({ afwerking: { sfx: false } }));
    }

    // -----------------------------------------------------------------------
    console.log('A1 ondertitels: presets (ASS-tekst)');
    {
      const woorden = spraak(0.4, 12, { woord: 0.35, gat: 0.15 });
      const shots = [shot(1, 0.2, 6.5)];
      const regels = groepeerRegels(woordenOpTijdlijn(shots, woorden));
      const pop = bouwAss(regels, { accent: '#ff8800', ondertitel_stijl: 'pop' });
      const strak = bouwAss(regels, { accent: '#ff8800', ondertitel_stijl: 'strak' });
      const karaoke = bouwAss(regels, { accent: '#ff8800', ondertitel_stijl: 'karaoke' });
      const standaard = bouwAss(regels, { accent: '#ff8800' });
      const dialogen = (a: string) => a.match(/^Dialogue:.*$/gm) ?? [];
      toets('standaard is pop', standaard === pop);
      toets('pop: actief woord ploft in (85% → 105% → 100% in 120 ms)', dialogen(pop).every((d) => /\\fscx85%?\\fscy85%?\\t\(0,60,\\fscx105%?\\fscy105%?\)\\t\(60,120,\\fscx10[0-4]%?\\fscy10[0-4]%?\)/.test(d)), dialogen(pop)[1] ?? '');
      toets('pop: actief woord in accentkleur', dialogen(pop).every((d) => d.includes('&H000088FF&')));
      const eersteVanRegel = dialogen(pop).filter((d) => /\\move\(/.test(d));
      toets('pop: regel komt binnen met korte slide + fade (één keer per regel)', eersteVanRegel.length === regels.length && eersteVanRegel.every((d) => /\\move\(\d+,\d+,\d+,\d+,0,110\)\\fad\(90,0\)/.test(d)), `${eersteVanRegel.length} vs ${regels.length}`);
      toets('strak: geen animatie', dialogen(strak).every((d) => !/\\t\(|\\move\(|\\fad\(/.test(d)));
      toets('strak: wel accentkleur', dialogen(strak).every((d) => d.includes('&H000088FF&')));
      const k2 = dialogen(karaoke)[regels[0].woorden.length - 1] ?? '';
      const accenten = (k2.match(/&H000088FF&/g) ?? []).length;
      toets('karaoke: gesproken woorden blijven accent (laatste woord van regel 1: alle woorden)', accenten >= regels[0].woorden.length, `${accenten} accenten in "${k2.slice(-160)}"`);
      toets('karaoke: geen pop-in', dialogen(karaoke).every((d) => !/\\fscx85/.test(d)));
      toets('evenveel dialogen in elke preset', dialogen(pop).length === dialogen(strak).length && dialogen(strak).length === dialogen(karaoke).length);
      process.env.MONTAGE_ONDERTITEL_STIJL = 'strak';
      toets('MONTAGE_ONDERTITEL_STIJL=strak als standaard', bouwAss(regels, { accent: '#ff8800' }) === strak);
      delete process.env.MONTAGE_ONDERTITEL_STIJL;
    }

    // -----------------------------------------------------------------------
    console.log('A2 zooms met easing en de hit');
    {
      const punch = effectKeten('punch_in', 3, { fps: 25, staand: true })!;
      const lineair = effectKeten('punch_in', 3, { fps: 25, staand: true, easing: false })!;
      toets('punch_in standaard met smoothstep', punch.includes('*(3-2*ld(0))'), punch);
      toets('easing uit: lineair', !lineair.includes('ld(0)') && lineair.startsWith('zoompan='), lineair);
      toets('snelle_zoom met smoothstep', effectKeten('snelle_zoom', 3, { fps: 25 })!.includes('*(3-2*ld(0))'));
      const hit = effectKeten('hit', 3, { fps: 25, vanaf: 0.4 })!;
      toets('hit: 1,08 vanaf 0,4 s (frame 10), 80 ms in, 300 ms uit', hit.includes(`1+${(instelling('HIT_SCHAAL') - 1).toFixed(3)}*if(lt(in,10.00)`) && hit.includes('/2.00') && hit.includes('/7.50'), hit);
      const wissel = effectKeten('wissel', 3, { fps: 25, van: 1, naar: 1.15 })!;
      toets('wissel: push 1,00 → 1,15 in RETENTIE_WISSEL_DUUR', wissel.includes('1.0000+(0.1500)*') && wissel.includes(`in/${(instelling('RETENTIE_WISSEL_DUUR') * 25).toFixed(2)}`), wissel);
      toets('origineel kader: geen hit of wissel', effectKeten('hit', 3, { staand: false }) === null && effectKeten('wissel', 3, { staand: false }) === null);

      // Echt door ffmpeg: een vast raster, de hit op 0,4 s. Vóór de hit en
      // ruim erna (≥ 0,4 + 0,08 + 0,3) is het beeld gelijk; op de piek niet.
      const raster = join(map, 'raster.mp4');
      const g = ff(['-f', 'lavfi', '-i', 'color=c=gray:s=1080x1920:r=25:d=1.2,drawgrid=w=60:h=60:t=3:c=white', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', raster]);
      const frame = (vf: string, n: number) =>
        ff(['-v', 'error', '-i', raster, '-vf', `${vf},select=eq(n\\,${n}),scale=108:192`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']).buf;
      const verschil = (a: Buffer, b: Buffer) => (a.length && a.length === b.length ? a.reduce((t, x, i) => t + Math.abs(x - b[i]), 0) / a.length : 255);
      const voor = frame(hit, 5);
      const piek = frame(hit, 12);
      const na = frame(hit, 25);
      toets('hit rendert (ffmpeg)', g.ok && voor.length > 0 && piek.length > 0, g.uit.slice(-200));
      toets('hit: op de piek ingezoomd', verschil(voor, piek) > 3, verschil(voor, piek).toFixed(2));
      toets('hit: daarna weer terug', verschil(voor, na) < 1, verschil(voor, na).toFixed(2));
      const w = ff(['-v', 'error', '-i', raster, '-vf', `${wissel},${punch}`, '-f', 'null', '-']);
      toets('wissel + punch_in renderen (ffmpeg)', w.ok, w.uit.slice(-200));
    }

    // -----------------------------------------------------------------------
    console.log('A3 kleur: normaliseren zonder clippen');
    {
      const donker = kleurCorrectie({ yavg: 50, ylow: 16, yhigh: 120, satavg: 20, frames: 3 });
      const licht = kleurCorrectie({ yavg: 190, ylow: 90, yhigh: 236, satavg: 30, frames: 3 });
      const vol = kleurCorrectie({ yavg: 118, ylow: 16, yhigh: 235, satavg: 30, frames: 3 });
      const na = (k: ReturnType<typeof kleurCorrectie>, y: number) => (y - 128) * k.contrast + 128 + k.helderheid * 255;
      toets('donkere bron wordt lichter', donker.helderheid > 0 && na(donker, 50) > 50, donker.detail);
      toets('donkere bron: niets onder 16 of boven 240', na(donker, 16) >= 15.5 && na(donker, 120) <= 240.5, donker.detail);
      toets('lichte bron wordt niet lichter en clipt niet', licht.helderheid <= 0 && na(licht, 236) <= 240.5 && na(licht, 90) >= 15.5, licht.detail);
      toets('bron die het bereik al vult: contrast blijft 1', Math.abs(vol.contrast - 1) < 1e-6, vol.detail);
      toets('verzadiging licht omhoog', /saturation=1\.06/.test(vol.filter ?? ''), vol.filter ?? '');
      toets('zonder meting: geen filter', kleurCorrectie(null).filter === null);

      // Echt gemeten: een onderbelichte bron, vóór en na het filter.
      const bron = join(map, 'donker.mp4');
      ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2', '-vf', 'eq=brightness=-0.22:contrast=0.7', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', bron]);
      const m = await meetKleur(bron, [0.3, 1.0, 1.6]);
      const k = kleurCorrectie(m);
      const gecorrigeerd = join(map, 'gecorrigeerd.mp4');
      const r = ff(['-i', bron, '-vf', k.filter ?? 'null', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', gecorrigeerd]);
      const m2 = await meetKleur(gecorrigeerd, [0.3, 1.0, 1.6]);
      console.log(`    gemeten: ${k.detail}; na: gem. ${m2?.yavg.toFixed(0)}, bereik ${m2?.ylow}–${m2?.yhigh}`);
      toets('meting werkt (signalstats)', Boolean(m && m.frames === 3));
      toets('filter rendert', r.ok, r.uit.slice(-200));
      toets('na correctie dichter bij het doel', Boolean(m && m2 && Math.abs(m2.yavg - instelling('KLEUR_DOEL_YAVG')) < Math.abs(m.yavg - instelling('KLEUR_DOEL_YAVG'))), `${m?.yavg} → ${m2?.yavg}`);
      toets('na correctie geen clipping (≤ 240, ≥ 16)', Boolean(m2 && m2.yhigh <= 240 && m2.ylow >= 16), `${m2?.ylow}–${m2?.yhigh}`);

      // LUT per campagne: assets/lut/<naam>.cube (hier een identiteits-LUT in een tijdelijke map).
      const cwd = process.cwd();
      const lutMap = join(map, 'lutproject');
      mkdirSync(join(lutMap, 'assets', 'lut'), { recursive: true });
      const regelsLut = ['LUT_3D_SIZE 2'];
      for (let b = 0; b < 2; b++) for (let gg = 0; gg < 2; gg++) for (let rr = 0; rr < 2; rr++) regelsLut.push(`${rr} ${gg} ${b}`);
      writeFileSync(join(lutMap, 'assets', 'lut', 'campagne.cube'), regelsLut.join('\n') + '\n');
      process.chdir(lutMap);
      const metLut = kleurCorrectie(m, { lut: 'campagne' });
      const zonder = kleurCorrectie(m, { lut: 'bestaatniet' });
      process.chdir(cwd);
      toets('LUT wordt achter de correctie gezet', /,lut3d=file=/.test(metLut.filter ?? ''), metLut.filter ?? '');
      toets('ontbrekende LUT: stil overgeslagen', !/lut3d/.test(zonder.filter ?? '') && zonder.lut === null);
      const rl = ff(['-v', 'error', '-i', bron, '-vf', metLut.filter!, '-f', 'null', '-']);
      toets('lut3d rendert (ffmpeg)', rl.ok, rl.uit.slice(-200));
    }

    // -----------------------------------------------------------------------
    console.log('A4 stem: broadcast-keten vóór loudnorm');
    {
      // "Spraak": roze ruis in lettergrepen (4 Hz), zinnen van 2 s met 0,5 s
      // stilte, dan 4 s gelijkmatige klank (vaste RMS) om pompen te meten.
      const stem = join(map, 'stem.wav');
      const g = ff([
        '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.25:duration=14:seed=7',
        '-f', 'lavfi', '-i', "aevalsrc='0.12*(sin(2*PI*200*t)+sin(2*PI*450*t)+sin(2*PI*1100*t)+sin(2*PI*2500*t))':s=48000:d=14",
        '-filter_complex',
        "[0]volume='if(lt(t,10),if(lt(mod(t,2.5),2),0.3+0.7*abs(sin(2*PI*4*t)),0.01),0)':eval=frame[s];" +
          "[1]volume='if(lt(t,10),0,1)':eval=frame[k];[s][k]amix=inputs=2:normalize=0",
        '-ar', '48000', '-ac', '1', stem,
      ]);
      toets('testspraak gegenereerd', g.ok, g.uit.slice(-200));
      const oud = lufsTweePass(stem, 'highpass=f=75,speechnorm=e=5:r=0.00001:l=1');
      const nieuw = lufsTweePass(stem, stemKeten(false));
      console.log(`    LUFS (loudnorm in twee passes, zoals de render): oude keten ${oud}, nieuwe keten ${nieuw}`);
      toets('keten parseert en rendert', Number.isFinite(nieuw));
      toets('luidheid blijft op -14 LUFS (±1)', Math.abs(nieuw + 14) <= 1, String(nieuw));
      toets('luidheid gelijk aan de oude keten (±1 LU)', Math.abs(nieuw - oud) <= 1, `${oud} vs ${nieuw}`);
      const verwerkt = join(map, 'stem-uit.wav');
      ff(['-i', stem, '-af', `${stemKeten(false)}`, '-ar', '48000', verwerkt]);
      // Direct na de spraak (vanaf 10,05 s) een gelijkmatige klank: een compressor die pompt (te
      // snelle release, te hoge ratio) laat die na het wegvallen van de
      // spraak hoorbaar aanzwellen. De keten mag niets toevoegen.
      const zwaai = (pad: string) => {
        const s = pcm(pad);
        const rms: number[] = [];
        for (let t = 10.05; t < 13.5; t += 0.1) {
          let e = 0;
          const a = Math.floor(t * 48000);
          for (let i = a; i < a + 4800; i++) e += s[i] * s[i];
          rms.push(10 * Math.log10(e / 4800 + 1e-12));
        }
        return Math.max(...rms) - Math.min(...rms);
      };
      const zIn = zwaai(stem);
      const zUit = zwaai(verwerkt);
      console.log(`    schommeling per 100 ms: bron ${zIn.toFixed(2)} dB, na de keten ${zUit.toFixed(2)} dB`);
      toets('geen pompen: gelijkmatige klank blijft gelijkmatig (≤ 0,5 dB meer dan de bron)', zUit <= zIn + 0.5, `${zIn.toFixed(2)} → ${zUit.toFixed(2)} dB`);
      const ruisig = stemKeten(true);
      toets('ruisige bron: sterkere ruisonderdrukking', ruisig.includes('afftdn=nf=-24') && stemKeten(false).includes('afftdn=nf=-30'));
    }

    // -----------------------------------------------------------------------
    console.log('B5 sound design: spaarzaam en mechanisch');
    {
      // 5 shots, payoff als laatste; de payoff begint na 0,25 s stilte.
      const w = [...spraak(10, 20), ...spraak(30, 10), ...spraak(50.25, 8)];
      const segs = [
        shot(1, 9.9, 17.9, { functie: 'hook' }),
        shot(2, 29.9, 32.0, { functie: 'context' }),
        shot(3, 32.0, 33.9, { functie: 'escalatie', zachteWissel: true }),
        shot(4, 33.9, 34.0, { functie: 'escalatie' }),
        shot(5, 50.0, 53.5, { functie: 'payoff' }),
      ];
      const p = payoffMoment(segs, w)!;
      const verwachtT = 8 + 2.1 + 1.9 + 0.1 + 0.25;
      toets('payoff-woord op de tijdlijn gevonden', Math.abs(p.t - verwachtT) < 0.01, `${p.t} vs ${verwachtT}`);
      const hitT = zetHit(segs, w);
      toets('hit-zoom op het payoff-woord', segs[4].hit !== undefined && Math.abs(segs[4].hit - 0.25) < 0.01 && hitT === p.t, String(segs[4].hit));
      const plan = planSfx(segs, {
        woorden: w,
        hookTot: 2,
        kaarten: [
          { start: 1, end: 3, tekst: 'hook' },
          { start: 7.0, end: 9.0, tekst: '87% haakt af' },
          { start: 10.3, end: 12, tekst: 'zonder getal' },
        ],
      });
      console.log(`    plan: ${plan.map((x) => `${x.slug}@${x.t}`).join(', ')}`);
      const slugOp = (slug: string) => plan.find((x) => x.slug === slug);
      toets('impact op het payoff-woord', Math.abs((slugOp('impact')?.t ?? -9) - (p.t - 0.02)) < 0.01);
      toets('riser 1,4 s vóór de payoff', Math.abs((slugOp('riser')?.t ?? -9) - (p.t - 1.4)) < 0.01);
      toets('ding onder de kaart met een getal', Math.abs((slugOp('ding')?.t ?? -9) - 7.0) < 0.01);
      toets('geen effect op de hookkaart', !plan.some((x) => x.t < 2));
      const buiten = plan.filter((x) => x.slug !== 'riser' && x.slug !== 'impact');
      const minAfstand = Math.min(...plan.flatMap((a, i) => plan.slice(i + 1).filter((b) => !(['riser', 'impact'].includes(a.slug) && ['riser', 'impact'].includes(b.slug))).map((b) => Math.abs(a.t - b.t))));
      toets('hoogstens één effect per SFX_MIN_AFSTAND (riser + impact samen één gebaar)', minAfstand >= instelling('SFX_MIN_AFSTAND') - 1e-6, String(minAfstand));
      toets('kaart en kaderwissel vlak bij de riser: geen extra whoosh', !buiten.some((x) => x.slug === 'whoosh'));
      toets('laag volume', plan.every((x) => (x.volume ?? 1) <= instelling('SFX_VOLUME') * 1.25 + 1e-6));
      const zonderPayoff = planSfx([shot(1, 0, 20), shot(2, 20, 25, { zachteWissel: true })], {});
      toets('zonder payoff/kaarten alleen een whoosh op de kaderwissel', zonderPayoff.length === 1 && zonderPayoff[0].slug === 'whoosh' && Math.abs(zonderPayoff[0].t - 19.88) < 0.01, JSON.stringify(zonderPayoff));
      const nietElkeKnip = planSfx([shot(1, 0, 4), shot(2, 10, 14), shot(3, 20, 24), shot(4, 30, 34)], {});
      toets('geen whoosh op gewone knippen', nietElkeKnip.length === 0);
      const voorstellen = planSfx(
        [shot(1, 0, 4, { sfx: 'whoosh' }), shot(2, 10, 12, { sfx: 'record_scratch' }), shot(3, 20, 21, { sfx: 'stilte' }), shot(4, 30, 34, { sfx: 'whoosh' }), shot(5, 40, 44, { sfx: 'riser' })],
        { hookTot: 2 },
      );
      toets(
        'voorstellen van de edit-agent: niet in de hook, geen stilte, en met afstand',
        JSON.stringify(voorstellen.map((x) => [x.slug, x.t])) === JSON.stringify([['record_scratch', 4], ['whoosh', 7], ['riser', 11]]),
        JSON.stringify(voorstellen),
      );
    }

    // -----------------------------------------------------------------------
    console.log('C7 J/L-cuts alleen waar de naad het toelaat');
    {
      const d = instelling('JL_DUUR');
      // Naad 1: stilte aan beide kanten, volgende spreker begint pas na 0,5 s → L.
      // Naad 2: volgende spreker begint direct (0,05 s), stilte ervoor → J.
      // Naad 3: vorige woord loopt tot het einde en volgende begint direct → niets.
      // Naad 4: retentieknip (strakBegin) → niets. Naad 5: aansluitend → niets.
      const w: BronWoord[] = [
        ...spraak(10, 5), // 10 – 11.9
        ...spraak(20.5, 5), // shot 2 begint op 20, eerste woord 20,5
        ...spraak(30.05, 5), // shot 3 begint op 30, eerste woord 30,05
        ...spraak(40, 5), // shot 3 eindigt op 41,95 midden in woorden-stilte? zie hieronder
        ...spraak(49.8, 6),
      ];
      const segs = [
        shot(1, 9.9, 12.2),
        shot(2, 20, 22.6),
        shot(3, 30, 32.0),
        shot(4, 39.95, 41.9),
        shot(5, 49.8, 51.0, { strakBegin: true }),
        shot(6, 51.0, 52.2),
      ];
      // Woord dat na het einde van shot 3 nog klinkt (32,02) en vóór het begin van shot 4 (39,9).
      w.push({ w: 'na', s: 32.02, e: 32.3 }, { w: 'voor', s: 39.7, e: 39.93 });
      w.sort((a, b) => a.s - b.s);
      const jl = planJL(segs, w);
      console.log(`    ${jl.map((x) => `${x.soort}@${x.naad + 1}`).join(', ')}`);
      toets('naad 1: L-cut (stilte aan beide kanten)', segs[0].audioNaad === d);
      toets('naad 2: J-cut (spreker begint direct)', segs[1].audioNaad === -d);
      toets('naad 3: niets (woorden aan beide kanten)', segs[2].audioNaad === undefined);
      toets('naad 4: retentieknip blijft strak', segs[3].audioNaad === undefined);
      toets('naad 5: aansluitend blijft zoals het is', segs[4].audioNaad === undefined);
      // Het verschoven stuk bevat nooit een woord.
      const stil = (van: number, tot: number) => !w.some((x) => x.e > van + 0.02 && x.s < tot - 0.02);
      toets(
        'geen woord in een verschoven stuk',
        segs.every((s, i) => {
          if (!s.audioNaad || i + 1 >= segs.length) return true;
          const b = segs[i + 1];
          return s.audioNaad > 0 ? stil(s.end, s.end + s.audioNaad) && stil(b.start, b.start + s.audioNaad) : stil(s.end + s.audioNaad, s.end) && stil(b.start + s.audioNaad, b.start);
        }),
      );
      toets('opnieuw plannen is idempotent', JSON.stringify(planJL(segs, w)) === JSON.stringify(jl));
      toets('zonder woorden: geen J/L', planJL(segs, null).length === 0 && segs.every((s) => s.audioNaad === undefined));
    }

    // -----------------------------------------------------------------------
    console.log('C8 adem: pauzes op tempo, functionele stiltes blijven');
    {
      const doelen = { ...STANDAARD_DOELEN };
      // Snelle spreker (5 w/s): een gat van 0,42 s is hier al dode lucht.
      const snel = spraak(100, 40, { woord: 0.15, gat: 0.05, pauzes: { 10: 0.37 } });
      const segSnel = [shot(1, 99.9, snel[39].e + 0.1)];
      toets('tempo snelle spreker ≈ 5 w/s', Math.abs((spreekTempo(segSnel, snel) ?? 0) - 5) < 0.3, String(spreekTempo(segSnel, snel)));
      const uitSnel = pasRetentieToe(segSnel, { bronWoorden: snel, doelen, ondertitels: true });
      toets('snelle spreker: 0,42 s pauze geknipt', uitSnel.ingrepen.some((g) => g.soort === 'pauze'), uitSnel.ingrepen.map((g) => g.wat).join(' | '));
      // Trage spreker (1,7 w/s): een gat van 0,6 s is ademruimte.
      const traag = spraak(100, 30, { woord: 0.5, gat: 0.1, pauzes: { 10: 0.5 } });
      const uitTraag = pasRetentieToe([shot(1, 99.9, traag[29].e + 0.1)], { bronWoorden: traag, doelen, ondertitels: true });
      toets('trage spreker: 0,6 s pauze blijft', !uitTraag.ingrepen.some((g) => g.soort === 'pauze'), uitTraag.ingrepen.map((g) => g.wat).join(' | '));
      // Na een vraag blijft de pauze staan.
      const vraag = spraak(100, 40, { pauzes: { 10: 0.9 }, tekst: (i) => (i === 10 ? 'toch?' : `woord${i}`) });
      const uitVraag = pasRetentieToe([shot(1, 99.9, vraag[39].e + 0.1)], { bronWoorden: vraag, doelen, ondertitels: true });
      toets('pauze na een vraag blijft', !uitVraag.ingrepen.some((g) => g.soort === 'pauze') && uitVraag.ingrepen.some((g) => /na een vraag/.test(g.wat)));
      // Na een zinseinde blijft er RETENTIE_PAUZE_REST_ZIN staan.
      const zin = spraak(100, 40, { pauzes: { 10: 0.9 }, tekst: (i) => (i === 10 ? 'klaar.' : `woord${i}`) });
      const segZin = [shot(1, 99.9, zin[39].e + 0.1)];
      const uitZin = pasRetentieToe(segZin, { bronWoorden: zin, doelen, ondertitels: true });
      const duur = (s: Shot[]) => s.reduce((t, x) => t + (x.end - x.start), 0);
      const weg = duur(segZin) - duur(uitZin.segmenten);
      toets('na een zinseinde blijft 0,22 s adem', Math.abs(weg - (1.0 - instelling('RETENTIE_PAUZE_REST_ZIN'))) < 0.02, weg.toFixed(3));
      // Vlak vóór de payoff: de stilte is de spanning.
      const voor = spraak(100, 30, { pauzes: { 28: 0.7 } });
      const eind = voor[29].e + 0.1;
      const uitVoor = pasRetentieToe([shot(1, 99.9, eind), shot(2, 200, 203, { functie: 'payoff' })], { bronWoorden: [...voor, ...spraak(200.1, 6)], doelen, ondertitels: true });
      toets('pauze vlak vóór de payoff blijft', !uitVoor.ingrepen.some((g) => g.soort === 'pauze' && g.volgorde === 1) && uitVoor.ingrepen.some((g) => /vóór de payoff/.test(g.wat)), uitVoor.ingrepen.map((g) => g.wat).join(' | '));
    }

    // -----------------------------------------------------------------------
    console.log('B6 muziek: tracks, beats en knippen op de beat');
    {
      const muziekMap = join(map, 'muziek');
      mkdirSync(join(muziekMap, 'spanningsbed'), { recursive: true });
      // Twee tracks: een klik op elke halve seconde (120 bpm) boven een zachte toon.
      for (const naam of ['a.mp3', 'b.mp3']) {
        ff(['-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.5),0.03),0.8*sin(2*PI*1000*t),0)+0.05*sin(2*PI*110*t)':s=44100:d=20", '-c:a', 'libmp3lame', '-b:a', '128k', join(muziekMap, 'spanningsbed', naam)]);
      }
      writeFileSync(join(muziekMap, 'spanningsbed', 'LEESMIJ.txt'), 'geen audio');
      ff(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*220*t)*(0.8+0.2*sin(2*PI*0.2*t))':s=44100:d=20", '-c:a', 'libmp3lame', join(muziekMap, 'drone.mp3')]);
      toets('alleen audiobestanden zijn tracks', tracksVoor('spanningsbed', muziekMap).length === 2);
      toets('onbekende sfeer of pad-trucs: geen track', kiesTrack('bestaatniet', 'x', muziekMap) === null && kiesTrack('../muziek', 'x', muziekMap) === null);
      const k1 = kiesTrack('spanningsbed', 'video|1', muziekMap);
      toets('keuze is deterministisch op het clip-id', k1 !== null && kiesTrack('spanningsbed', 'video|1', muziekMap) === k1);
      const keuzes = new Set(Array.from({ length: 12 }, (_, i) => kiesTrack('spanningsbed', `video|${i}`, muziekMap)));
      toets('clips lopen uiteen over de tracks', keuzes.size === 2);
      const a = await analyseerBeats(k1!);
      console.log(`    ${a?.bpm} bpm, ${a?.beats.length} beats, zekerheid ${a?.zekerheid}, eerste ${a?.beats.slice(0, 4).join(', ')}`);
      toets('tempo 120 bpm gemeten', Boolean(a && Math.abs(a.bpm - 120) <= 3), String(a?.bpm));
      const opRaster = a ? a.beats.filter((b) => Math.abs(b - Math.round(b / 0.5) * 0.5) < 0.05).length / a.beats.length : 0;
      toets('beats liggen op de klikken (±50 ms)', opRaster > 0.9, opRaster.toFixed(2));
      toets('duidelijke puls', Boolean(a && a.zekerheid >= BEAT_MIN_ZEKERHEID), String(a?.zekerheid));
      const drone = await analyseerBeats(join(muziekMap, 'drone.mp3'));
      toets('drone zonder puls: geen knippen op de beat', Boolean(drone && drone.zekerheid < BEAT_MIN_ZEKERHEID), String(drone?.zekerheid));
      toets('beats herhalen met de track mee', a ? beatsOpTijdlijn(a, 45).some((b) => b > 40) : false);

      // Knippen: naad 1 (echte knip, stilte na het laatste woord) valt op
      // 3,08 → naar de beat op 3,0. Naad 2 (echte knip, woord loopt tot de
      // grens) → mag niet inkorten. Naad 3 (aansluitende kaderwissel in een
      // woordgat) schuift als geheel.
      const beats = Array.from({ length: 40 }, (_, i) => i * 0.5);
      const w: BronWoord[] = [
        ...spraak(10, 6), // 10 – 12.3
        ...spraak(20, 4), { w: 'tot', s: 21.9, e: 22.07 },
        ...spraak(30, 3), { w: 'na', s: 31.6, e: 31.9 },
      ];
      w.sort((x, y) => x.s - y.s);
      const segs = [shot(1, 9.9, 12.98), shot(2, 20, 22.08), shot(3, 30, 31.46), shot(4, 31.46, 33)];
      // tijdlijn: naad 1 op 3,08 (→ 3,0); naad 2 op 5,08; naad 3 op 6,54
      const r = knipOpBeat(segs, beats, w);
      toets('naad 1 schuift naar de beat (3,0)', Math.abs(segs[0].end - 12.9) < 1e-6, String(segs[0].end));
      toets('naad 2 niet door een woord', Math.abs(segs[1].end - 22.08) < 1e-6, String(segs[1].end));
      const t3 = segs.slice(0, 3).reduce((t, s) => t + (s.end - s.start), 0);
      toets('naad 3 (kaderwissel) op de beat en aansluitend', Math.abs(t3 - 6.5) < 1e-6 && segs[3].start === segs[2].end, `${t3} ${segs[2].end}/${segs[3].start}`);
      toets('telling', r.verschoven === 2 && r.kandidaten === 3, JSON.stringify(r));
      toets('geen grens in een woord', segs.every((s) => !w.some((x) => (s.start > x.s + 0.02 && s.start < x.e - 0.02) || (s.end > x.s + 0.02 && s.end < x.e - 0.02))));
      toets('tweede keer: niets meer te doen', knipOpBeat(segs, beats, w).verschoven === 0);
    }
  } finally {
    rmSync(map, { recursive: true, force: true });
  }

  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
