import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { instelling } from './instellingen';
import type { Shot } from './index';
import type { BronWoord } from './woorden';

/**
 * Echte muziektracks in plaats van één vast bed per sfeer.
 *
 * assets/muziek/<sfeer>/*.mp3 (of .wav/.m4a): per clip één track, vast
 * gekozen op het clip-id — dezelfde clip krijgt bij een herrender dezelfde
 * track, en clips van één video krijgen niet allemaal dezelfde. Is de map er
 * niet of leeg, dan valt de worker terug op het oude gedrag
 * (assets/muziek/<sfeer>.mp3 via zorgVoorMuziekbed).
 *
 * Met een echte track kan de montage op de muziek gaan staan: de beats worden
 * hier gemeten (energie-onsets, geen externe bibliotheek) en knippen die een
 * fractie naast een beat vallen, schuiven erop — alleen binnen stilte, nooit
 * door een woord.
 */

const EXTENSIES = /\.(mp3|wav|m4a)$/i;

export function tracksVoor(sfeer: string, map = join(process.cwd(), 'assets', 'muziek')): string[] {
  if (!sfeer || sfeer === 'geen' || /[\\/]|\.\./.test(sfeer)) return [];
  const dir = join(map, sfeer);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => EXTENSIES.test(n) && !n.startsWith('.'))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** Deterministische keuze op het clip-id (sha1, dus stabiel over machines). */
export function kiesTrack(sfeer: string, clipId: string, map?: string): string | null {
  const tracks = tracksVoor(sfeer, map);
  if (tracks.length === 0) return null;
  const h = createHash('sha1').update(`${sfeer}|${clipId}`).digest();
  return tracks[h.readUInt32BE(0) % tracks.length];
}

/**
 * Onder deze verhouding (onsets op de beats t.o.v. gemiddeld) heeft een track
 * geen duidelijke puls — een ambient bed — en heeft knippen op de beat geen zin.
 */
export const BEAT_MIN_ZEKERHEID = 1.5;

const SR = 11025;
const HOP = 256; // ≈ 23 ms per stap

async function decodeerMono(pad: string, maxS = 240): Promise<Float32Array> {
  return new Promise((klaar, faal) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-t', String(maxS), '-i', pad, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const delen: Buffer[] = [];
    kind.stdout.on('data', (d: Buffer) => delen.push(d));
    kind.on('error', faal);
    kind.on('close', (code) => {
      if (code !== 0) return faal(new Error(`ffmpeg decode gaf ${code}`));
      const buf = Buffer.concat(delen);
      const uit = new Float32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < uit.length; i++) uit[i] = buf.readFloatLE(i * 4);
      klaar(uit);
    });
  });
}

export type BeatAnalyse = { beats: number[]; bpm: number; duur: number; zekerheid: number };

/**
 * Beats uit een onset-envelop (positieve sprongen in log-energie per 23 ms).
 * Tempo via autocorrelatie tussen 70 en 170 bpm, met een lichte voorkeur rond
 * 110; daarna een eenvoudige beat-tracker: elke voorspelde beat schuift naar
 * de sterkste onset binnen ±2 stappen, zodat een track die iets afwijkt van
 * een heel getal stappen niet wegdrijft.
 */
export function beatsUitSamples(samples: Float32Array, sr = SR): BeatAnalyse {
  const hopS = HOP / sr;
  const n = Math.floor(samples.length / HOP);
  const duur = samples.length / sr;
  if (n < 64) return { beats: [], bpm: 0, duur, zekerheid: 0 };
  const loge = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = i * HOP; j < (i + 1) * HOP; j++) e += samples[j] * samples[j];
    loge[i] = Math.log10(1e-9 + e / HOP);
  }
  const onset = new Float32Array(n);
  for (let i = 1; i < n; i++) onset[i] = Math.max(0, loge[i] - loge[i - 1]);
  const gem = onset.reduce((a, b) => a + b, 0) / n;
  if (gem <= 0) return { beats: [], bpm: 0, duur, zekerheid: 0 };

  const minLag = Math.round(60 / 170 / hopS);
  const maxLag = Math.round(60 / 70 / hopS);
  let besteLag = 0;
  let besteScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += onset[i] * onset[i - lag];
    s /= n - lag;
    const bpm = 60 / (lag * hopS);
    const gewicht = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.9, 2));
    if (s * gewicht > besteScore) {
      besteScore = s * gewicht;
      besteLag = lag;
    }
  }
  // Fractionele periode: parabool door de autocorrelatie rond de beste lag.
  // Een heel getal stappen (23 ms) drijft over een minuut een halve tel weg.
  const ac = (lag: number) => {
    let s = 0;
    for (let i = lag; i < n; i++) s += onset[i] * onset[i - lag];
    return s / (n - lag);
  };
  const [l0, l1, l2] = [ac(besteLag - 1), ac(besteLag), ac(besteLag + 1)];
  const noemer = l0 - 2 * l1 + l2;
  const periode = besteLag + (noemer < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l0 - l2)) / noemer)) : 0);
  // Onset rond een stap: de sterkste binnen ±2 (piek-plukken, voor beats en
  // voor de vergelijking tussen de beats evenveel).
  const piek = (p: number) => {
    let top = Math.max(0, Math.min(n - 1, Math.round(p)));
    for (let k = Math.max(0, top - 2); k <= Math.min(n - 1, top + 2); k++) if (onset[k] > onset[top]) top = k;
    return top;
  };
  // Fase: waar op het (fractionele) raster valt de meeste energie?
  let besteFase = 0;
  let faseScore = -Infinity;
  for (let f = 0; f < periode; f += 0.5) {
    let s = 0;
    for (let p = f; p < n; p += periode) s += onset[Math.round(p)] ?? 0;
    if (s > faseScore) {
      faseScore = s;
      besteFase = f;
    }
  }
  // Volgen: elke voorspelde beat naar de sterkste onset dichtbij, als die er
  // echt is; anders op het raster blijven.
  const beats: number[] = [];
  let opBeat = 0;
  let ertussen = 0;
  for (let p = besteFase; p < n - 1; ) {
    const top = piek(p);
    const echt = onset[top] > gem;
    const plek = echt ? top : Math.round(p);
    beats.push(Math.round(plek * hopS * 1000) / 1000);
    opBeat += onset[top];
    ertussen += onset[piek(plek + periode / 2)];
    p = plek + periode;
  }
  return {
    beats,
    bpm: Math.round(60 / (periode * hopS)),
    duur,
    // Hoeveel sterker de onsets óp de beats zijn dan halverwege ertussen
    // (op dezelfde manier geplukt): bij een ambient bed of drone ≈ 1, en dan
    // heeft snappen geen zin.
    zekerheid: Math.round((opBeat / Math.max(1e-9, ertussen)) * 100) / 100,
  };
}

const cache = new Map<string, BeatAnalyse>();

export async function analyseerBeats(pad: string): Promise<BeatAnalyse | null> {
  if (cache.has(pad)) return cache.get(pad)!;
  try {
    const a = beatsUitSamples(await decodeerMono(pad));
    cache.set(pad, a);
    return a;
  } catch {
    return null;
  }
}

/** De beats op de tijdlijn: de render herhaalt de track zo vaak als nodig. */
export function beatsOpTijdlijn(a: BeatAnalyse, totaal: number): number[] {
  if (a.beats.length === 0 || a.duur <= 0) return [];
  const uit: number[] = [];
  for (let ronde = 0; ronde * a.duur < totaal; ronde++) for (const b of a.beats) if (b + ronde * a.duur <= totaal) uit.push(b + ronde * a.duur);
  return uit;
}

/**
 * Schuift knippen op de dichtstbijzijnde beat, hoogstens BEAT_MAX_VERSCHUIF.
 * Een echte knip (naar ander bronmateriaal) verschuift door het einde van
 * het vorige shot te verlengen of in te korten — alleen als dat stuk stil is
 * en er minstens 60 ms rust na het laatste woord blijft. Een kaderwissel in
 * doorlopende spraak verschuift beide grenzen samen, maar nooit tot midden in
 * een woord. Muteert de segmenten; levert het aantal verschoven knippen.
 */
export function knipOpBeat(alle: Shot[], beats: number[], woorden: BronWoord[] | null): { verschoven: number; kandidaten: number } {
  const max = instelling('BEAT_MAX_VERSCHUIF');
  const RUST = 0.06;
  const segmenten = [...alle].sort((a, b) => a.volgorde - b.volgorde);
  let verschoven = 0;
  let kandidaten = 0;
  if (beats.length === 0) return { verschoven, kandidaten };
  const w = woorden ?? [];
  const vrij = (van: number, tot: number) => !w.some((x) => x.e > van && x.s < tot);
  const inWoord = (t: number) => w.some((x) => t > x.s + 0.02 && t < x.e - 0.02);
  let t = 0;
  for (let i = 0; i + 1 < segmenten.length; i++) {
    const a = segmenten[i];
    const b = segmenten[i + 1];
    t += a.end - a.start;
    kandidaten++;
    let beste: number | null = null;
    for (const beat of beats) if (Math.abs(beat - t) <= max && (beste === null || Math.abs(beat - t) < Math.abs(beste - t))) beste = beat;
    if (beste === null) continue;
    const d = beste - t;
    if (Math.abs(d) < 0.01) continue;
    const aansluitend = Math.abs(b.start - a.end) < 0.01;
    if (aansluitend) {
      const nieuw = a.end + d;
      if (inWoord(nieuw) || nieuw - a.start < 0.8 || b.end - nieuw < 0.8) continue;
      a.end = nieuw;
      b.start = nieuw;
    } else {
      if (a.tease || a.end - a.start + d < 0.8) continue;
      const ok = d > 0 ? vrij(a.end, a.end + d + RUST) : vrij(a.end + d - RUST, a.end);
      if (!ok) continue;
      a.end += d;
    }
    a.end = Math.round(a.end * 1000) / 1000;
    if (aansluitend) b.start = a.end;
    t += d;
    verschoven++;
  }
  return { verschoven, kandidaten };
}
