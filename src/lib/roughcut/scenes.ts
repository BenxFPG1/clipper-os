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

/**
 * De echte meter: scripts/gezichten.py (YuNet). `frames` per tijdstip: voor
 * het dichte scannen één (snel; het gladstrijken vangt een los gemist frame),
 * voor de keuring drie (robuust per meetpunt).
 */
export function gezichtMeterVia(bron: string, python: { cmd: string; voor: string[] }, frames = 3): GezichtMeter {
  return async (tijden) => {
    if (tijden.length === 0) return [];
    const uit = await new Promise<string>((klaar) => {
      const kind = spawn(python.cmd, [...python.voor, 'scripts/gezichten.py', bron, JSON.stringify(tijden), String(frames)]);
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
 * Waar in een overgangsvenster het beeld het sterkst verandert: het frame met
 * de hoogste scènescore (ffmpeg `scene`, zonder drempel). Bij een harde knip
 * is dat de knip; bij een overvloeier of animatie het steilste stuk ervan.
 * Geen meetbare piek → het midden van het venster.
 */
export async function overgangsPiek(bron: string, van: number, tot: number): Promise<number> {
  const uit = await new Promise<string>((klaar) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      [
        '-nostdin', '-hide_banner',
        '-ss', Math.max(0, van).toFixed(3), '-t', Math.max(0.1, tot - van).toFixed(3), '-i', bron,
        '-an', '-vf', "scale=160:-2,select='gte(scene\\,0)',metadata=print:key=lavfi.scene_score",
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
  let tijd: number | null = null;
  let beste = { t: (van + tot) / 2, score: instelling('SCENE_PIEK_MIN') };
  for (const regel of uit.split('\n')) {
    const pt = regel.match(/pts_time:\s*([\d.]+)/);
    if (pt) tijd = Number(pt[1]);
    const sc = regel.match(/lavfi\.scene_score=([\d.]+)/);
    if (sc && tijd !== null && Number(sc[1]) > beste.score) beste = { t: Math.max(0, van) + tijd, score: Number(sc[1]) };
  }
  return Math.round(beste.t * 1000) / 1000;
}

/**
 * Deelt elk segment op in stukken mét en zónder gezicht, met de
 * gezichtsdetectie als primaire bron.
 *
 * Eerst werd op scènewissels geknipt en per stuk 1-3 keer gemeten. Maar een
 * nieuwsbron gaat met een overvloeier of animatie naar zijn graphics: geen
 * harde knip, dus geen scène, dus 3 van de 4 graphics bleven vullend en werden
 * aangesneden ("< 3 maanden", "−39%"). Nu andersom: elke SCENE_STAP seconde
 * meten (één aanroep voor alle segmenten), aaneengesloten runs met en zonder
 * gezicht maken, korte runs (een wegkijkend hoofd, een gemiste detectie)
 * gladstrijken, en pas daarna de scènescore gebruiken om het wisselmoment
 * binnen het overgangsvenster op de visuele overgang te leggen.
 *
 * Alleen een segment met een wissel, of helemaal zonder gezicht, krijgt
 * `scenes`; een doorlopend sprekend hoofd blijft zoals het was.
 */
export async function vulScenes(
  bron: string,
  segmenten: Shot[],
  meter: GezichtMeter,
): Promise<{ shots: number; persoon: number; graphic: number; metingen: number; overgangen: number; ms: number }> {
  const begin = Date.now();
  const stap = instelling('SCENE_STAP');
  const glad = instelling('SCENE_GAT_GLAD');
  const marge = instelling('SCENE_OVERGANG_MARGE');

  const perSeg = segmenten.map((seg) => {
    const ts: number[] = [];
    for (let t = seg.start + stap / 2; t < seg.end - 0.05; t += stap) ts.push(Math.round(t * 1000) / 1000);
    if (ts.length === 0) ts.push(Math.round(((seg.start + seg.end) / 2) * 1000) / 1000);
    return ts;
  });
  const alle = perSeg.flat();
  const uitslag = await meter(alle);

  let persoon = 0;
  let graphic = 0;
  let shots = 0;
  let overgangen = 0;
  let cursor = 0;
  for (const [i, seg] of segmenten.entries()) {
    const ts = perSeg[i];
    const ruw = uitslag.slice(cursor, cursor + ts.length);
    cursor += ts.length;
    const waarden = vulGaten(ruw);
    if (!waarden) {
      seg.scenes = undefined; // niets gemeten: het kader van de visuele controle blijft
      continue;
    }
    const runs = strijkGlad(maakRuns(waarden), stap, glad);
    if (runs.length === 1 && runs[0].gezicht) {
      seg.scenes = undefined;
      continue;
    }
    // Wisselmomenten: tussen het laatste meetpunt van een run en het eerste
    // van de volgende, verfijnd op de scènescore.
    const grenzen: number[] = [];
    for (let r = 0; r + 1 < runs.length; r++) {
      const a = ts[runs[r].tot];
      const b = ts[runs[r + 1].van];
      grenzen.push(await overgangsPiek(bron, Math.max(seg.start, a - marge), Math.min(seg.end, b + marge)));
      overgangen++;
    }
    const randen = [seg.start, ...grenzen, seg.end];
    seg.scenes = runs.map((run, r) => ({ van: randen[r], tot: randen[r + 1], gezicht: run.gezicht }));
    shots++;
    for (const run of runs) run.gezicht ? persoon++ : graphic++;
  }
  return { shots, persoon, graphic, metingen: alle.length, overgangen, ms: Date.now() - begin };
}

/** Lege metingen opvullen met de dichtstbijzijnde buur; null als er helemaal niets gemeten is. */
function vulGaten(ruw: (boolean | null)[]): boolean[] | null {
  if (ruw.every((x) => x === null)) return null;
  const uit = [...ruw];
  for (let i = 1; i < uit.length; i++) if (uit[i] === null) uit[i] = uit[i - 1];
  for (let i = uit.length - 2; i >= 0; i--) if (uit[i] === null) uit[i] = uit[i + 1];
  return uit as boolean[];
}

type Run = { van: number; tot: number; gezicht: boolean };

function maakRuns(w: boolean[]): Run[] {
  const runs: Run[] = [];
  w.forEach((g, i) => {
    const laatste = runs[runs.length - 1];
    if (laatste && laatste.gezicht === g) laatste.tot = i;
    else runs.push({ van: i, tot: i, gezicht: g });
  });
  return runs;
}

/**
 * Runs korter dan `glad` seconden gaan op in hun buren: een hoofd dat even
 * wegdraait is geen graphic, en één losse detectie in een graphic geen
 * spreker. Telkens de kortste eerst, tot er niets korts meer over is.
 */
export function strijkGlad(runs: Run[], stap: number, glad: number): Run[] {
  const uit = runs.map((r) => ({ ...r }));
  for (;;) {
    if (uit.length <= 1) return uit;
    let k = -1;
    for (let i = 0; i < uit.length; i++) {
      const lengte = (uit[i].tot - uit[i].van + 1) * stap;
      if (lengte < glad && (k < 0 || lengte < (uit[k].tot - uit[k].van + 1) * stap)) k = i;
    }
    if (k < 0) return uit;
    const buur = k > 0 ? uit[k - 1] : uit[k + 1];
    uit[k].gezicht = buur.gezicht;
    // Samenvoegen met gelijke buren.
    const samen: Run[] = [];
    for (const r of uit) {
      const l = samen[samen.length - 1];
      if (l && l.gezicht === r.gezicht) l.tot = r.tot;
      else samen.push({ ...r });
    }
    uit.length = 0;
    uit.push(...samen);
  }
}
