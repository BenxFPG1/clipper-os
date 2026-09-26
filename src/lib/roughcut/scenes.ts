import { spawn } from 'node:child_process';
import { resolveBinary } from '../ingest/binaries';
import { instelling } from './instellingen';
import type { Kader } from './kader';
import type { Shot } from './index';

/**
 * Kaderkeuze per scène binnen een shot.
 *
 * Waarom: het beeldtype werd per shot bepaald op één controlebeeld, maar een
 * bron als een nieuwsuitzending knipt bínnen één shot (één doorlopende zin)
 * van de presentatrice naar een full-screen graphic en terug. Een shot dat
 * op de presentatrice 'vullend' kreeg, sneed daarna de helft van de graphic
 * weg ("PLATIN", "−39" half uit beeld). De oplossing volgt de bron zelf: op
 * elke scènewissel van de bron mag het kader wisselen, en per deelstuk
 * beslist de gezichtsmeting — mét gezicht vullend op het gezicht, zonder
 * gezicht passend met een geblurde achtergrond. De kaderwissel valt precies
 * op de bronknip, dus de kijker ziet geen extra sprong, en het geluid loopt
 * gewoon door (alleen de beeldketen wisselt).
 */

/** Een scène in bróntijd (absoluut), met of er een gezicht in staat; null = niet gemeten. */
export type Scene = { van: number; tot: number; gezicht: boolean | null };

/** Een deelstuk van een shot in shot-tijd (0 = begin van het shot), met het kader dat de render gebruikt. */
export type Deelstuk = { van: number; tot: number; kader: Kader; gezicht: boolean | null };

/**
 * Het kader voor een shot als geheel — de regel van vóór de deelstukken: het
 * beeldtype van de visuele controle wint per shot van de clipkeuze, in beide
 * richtingen (graphic → blur, sprekend hoofd in een blur-clip → vullend).
 */
export function kaderVoorShot(shot: Shot, kader: Kader): Kader {
  if (shot.beeldtype === 'graphic' && (kader === 'vullend' || kader === 'staand')) return 'blur';
  if (shot.beeldtype === 'persoon' && kader === 'blur') return 'vullend';
  return kader;
}

function kaderVoorScene(gezicht: boolean | null, shot: Shot, kader: Kader): Kader {
  if (kader === 'origineel') return kader;
  if (gezicht === false) return 'blur';
  if (gezicht === true) return kader === 'blur' || kader === 'staand' ? 'vullend' : kader;
  return kaderVoorShot(shot, kader);
}

/**
 * De deelstukken van een shot zoals de render ze maakt. Scènes staan in
 * absolute brontijd en overleven zo elke latere grensverschuiving; hier
 * worden ze op de huidige grenzen gelegd. Te korte stukjes gaan op in hun
 * buur, en aangrenzende stukken met hetzelfde kader worden één stuk — alleen
 * een échte kaderwissel is een splitsing.
 */
export function deelstukken(shot: Shot, kader: Kader): Deelstuk[] {
  const duur = shot.end - shot.start;
  const scenes = (shot.scenes ?? []).filter((s) => s.tot > shot.start && s.van < shot.end);
  if (scenes.length === 0 || kader === 'origineel') {
    return [{ van: 0, tot: duur, kader: kaderVoorShot(shot, kader), gezicht: null }];
  }
  const minDeel = instelling('SCENE_MIN_DEEL');
  let stukken = scenes
    .map((s) => ({
      van: Math.max(0, s.van - shot.start),
      tot: Math.min(duur, s.tot - shot.start),
      gezicht: s.gezicht,
    }))
    .sort((a, b) => a.van - b.van);
  // Gaten dichten en de randen op de shotgrenzen: de poort en de
  // aanloopcorrectie mogen een shot een fractie oprekken.
  stukken[0].van = 0;
  stukken[stukken.length - 1].tot = duur;
  for (let i = 1; i < stukken.length; i++) stukken[i].van = stukken[i - 1].tot;

  // Een flits van een paar frames is geen scène om op te kadreren.
  for (let i = stukken.length - 1; i >= 0 && stukken.length > 1; i--) {
    if (stukken[i].tot - stukken[i].van >= minDeel) continue;
    if (i > 0) stukken[i - 1].tot = stukken[i].tot;
    else stukken[1].van = stukken[0].van;
    stukken.splice(i, 1);
  }

  const metKader = stukken.map((s) => ({ ...s, kader: kaderVoorScene(s.gezicht, shot, kader) }));
  const samen: Deelstuk[] = [];
  for (const s of metKader) {
    const vorige = samen[samen.length - 1];
    if (vorige && vorige.kader === s.kader) {
      vorige.tot = s.tot;
      if (vorige.gezicht !== s.gezicht) vorige.gezicht = vorige.gezicht || s.gezicht;
    } else samen.push({ ...s });
  }
  return samen;
}

/** Het kader op een absoluut brontijdstip binnen het shot. */
export function kaderOpMoment(shot: Shot, kader: Kader, t: number): Kader {
  const rel = t - shot.start;
  const delen = deelstukken(shot, kader);
  return (delen.find((d) => rel >= d.van && rel < d.tot) ?? delen[delen.length - 1]).kader;
}

/** De scènewissels (absolute brontijd) binnen een bronvenster, via ffmpeg's scene-score. */
export async function detecteerSceneKnippen(bron: string, van: number, tot: number): Promise<number[]> {
  const drempel = instelling('SCENE_DREMPEL');
  const uit = await new Promise<string>((klaar) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      [
        '-nostdin', '-hide_banner',
        '-ss', Math.max(0, van).toFixed(3), '-t', Math.max(0.1, tot - van).toFixed(3), '-i', bron,
        '-an',
        // Klein decoderen: een scènewissel is ook op 320 breed een scènewissel.
        '-vf', `scale=320:-2,select='gt(scene\\,${drempel})',showinfo`,
        '-f', 'null', '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let alles = '';
    kind.stdout.on('data', (d) => (alles += d));
    kind.stderr.on('data', (d) => (alles += d));
    kind.on('error', () => klaar(''));
    kind.on('close', () => klaar(alles));
  });
  const knippen: number[] = [];
  for (const m of uit.matchAll(/pts_time:\s*([\d.]+)/g)) {
    const t = van + Number(m[1]);
    if (t > van + 0.05 && t < tot - 0.05) knippen.push(Math.round(t * 1000) / 1000);
  }
  return knippen;
}

/** Meet per tijdstip of er een gezicht in beeld is (null = niet te meten). */
export type GezichtMeter = (tijden: number[]) => Promise<(boolean | null)[]>;

/** De echte meter: scripts/gezichten.py (YuNet), drie frames per tijdstip. */
export function gezichtMeterVia(bron: string, python: { cmd: string; voor: string[] }): GezichtMeter {
  return async (tijden) => {
    if (tijden.length === 0) return [];
    const uit = await new Promise<string>((klaar) => {
      const kind = spawn(python.cmd, [...python.voor, 'scripts/gezichten.py', bron, JSON.stringify(tijden), '3']);
      let stdout = '';
      kind.stdout.on('data', (d) => (stdout += d));
      kind.stderr.on('data', () => {});
      kind.on('error', () => klaar(''));
      kind.on('close', () => klaar(stdout));
    });
    try {
      const regel = uit.split('\n').map((r) => r.trim()).reverse().find((r) => r.startsWith('['));
      const metingen = JSON.parse(regel || '[]') as unknown[];
      if (metingen.length !== tijden.length) return tijden.map(() => null);
      return metingen.map((m) => m !== null);
    } catch {
      return tijden.map(() => null);
    }
  };
}

/**
 * Zoekt per segment de scènewissels van de bron en meet per scène of er een
 * gezicht in staat. Alleen segmenten mét een wissel krijgen `scenes`; een shot
 * zonder bronknip houdt het kader van de visuele controle. Muteert de
 * segmenten en levert tellingen voor de log.
 */
export async function vulScenes(
  bron: string,
  segmenten: Shot[],
  meter: GezichtMeter,
): Promise<{ shots: number; persoon: number; graphic: number }> {
  const plan: { seg: Shot; stukken: { van: number; tot: number }[] }[] = [];
  for (const seg of segmenten) {
    const knippen = await detecteerSceneKnippen(bron, seg.start, seg.end);
    if (knippen.length === 0) {
      seg.scenes = undefined;
      continue;
    }
    const grenzen = [seg.start, ...knippen, seg.end];
    plan.push({ seg, stukken: grenzen.slice(0, -1).map((van, i) => ({ van, tot: grenzen[i + 1] })) });
  }
  if (plan.length === 0) return { shots: 0, persoon: 0, graphic: 0 };

  // Per stuk het midden, en bij een langer stuk ook de kwartpunten: één
  // ongelukkig frame (een knipperende blik, een halve overgang) mag het
  // oordeel niet bepalen. Meerderheid beslist.
  const tijden: number[] = [];
  const index: { p: number; k: number }[] = [];
  plan.forEach((pl, p) =>
    pl.stukken.forEach((st, k) => {
      const d = st.tot - st.van;
      const punten = d > 2 ? [0.25, 0.5, 0.75] : [0.5];
      for (const f of punten) {
        tijden.push(Math.round((st.van + d * f) * 1000) / 1000);
        index.push({ p, k });
      }
    }),
  );
  const uitslag = await meter(tijden);

  let persoon = 0;
  let graphic = 0;
  plan.forEach((pl, p) => {
    pl.seg.scenes = pl.stukken.map((st, k) => {
      const eigen = uitslag.filter((_, i) => index[i].p === p && index[i].k === k);
      const gemeten = eigen.filter((x): x is boolean => x !== null);
      const gezicht = gemeten.length === 0 ? null : gemeten.filter(Boolean).length * 2 >= gemeten.length;
      if (gezicht === true) persoon++;
      if (gezicht === false) graphic++;
      return { van: st.van, tot: st.tot, gezicht };
    });
  });
  return { shots: plan.length, persoon, graphic };
}
