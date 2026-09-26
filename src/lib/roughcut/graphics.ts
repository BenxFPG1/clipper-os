import { spawn } from 'node:child_process';
import { resolveBinary } from '../ingest/binaries';
import { instelling } from './instellingen';

/**
 * Slimme inzoom voor graphics.
 *
 * Een 16:9-graphic passend in een staand beeld beslaat maar een derde van de
 * hoogte; de kleine tekst erop ("BRON: …", assenlabels) is op een telefoon dan
 * onleesbaar. Maar een nieuwsgraphic is meestal een egaal vlak met inhoud in
 * het midden: meet waar de échte inhoud staat (tekst, cijfers, balken — alles
 * wat afwijkt van de achtergrondkleur), en kadreer zó dat die inhoud zo groot
 * mogelijk in 9:16 past.
 *
 * Harde regel: nooit inhoud afsnijden. De kadrering omvat altijd de hele
 * gemeten inhoud plus marge; is er geen betrouwbare meting (een foto, te veel
 * detail over het hele vlak), dan blijft het gewone passende kader.
 *
 * Alle coördinaten zijn genormaliseerd (0..1 van breedte en hoogte), dus de
 * meting op de analysebron geldt ook voor een renderbron in een andere
 * resolutie.
 */

export type Box = { x0: number; y0: number; x1: number; y1: number };

const MEET_B = 480;
const MEET_H = 270;

/**
 * De inhoudsbox uit één frame (rgb24, w×h). Achtergrond = de mediaankleur van
 * de rand; inhoud = elke pixel die daar duidelijk van afwijkt, minus losse
 * ruispixels. Null als het beeld geen egale achtergrond heeft (dan is er niets
 * om op in te zoomen zonder risico) of als de inhoud al vrijwel het hele vlak
 * vult (dan levert inzoomen niets op).
 */
export function inhoudsboxUitPixels(rgb: Buffer | Uint8Array, w: number, h: number): Box | null {
  const drempel = instelling('GRAPHIC_KLEUR_DREMPEL');
  const rand = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= rand && x < w - rand && y >= rand && y < h - rand) continue;
      const i = (y * w + x) * 3;
      r.push(rgb[i]);
      g.push(rgb[i + 1]);
      b.push(rgb[i + 2]);
    }
  }
  const mediaan = (xs: number[]) => xs.sort((p, q) => p - q)[Math.floor(xs.length / 2)];
  const bg = [mediaan(r), mediaan(g), mediaan(b)];

  const masker = new Uint8Array(w * h);
  let inhoud = 0;
  for (let p = 0; p < w * h; p++) {
    const i = p * 3;
    const verschil = Math.max(Math.abs(rgb[i] - bg[0]), Math.abs(rgb[i + 1] - bg[1]), Math.abs(rgb[i + 2] - bg[2]));
    if (verschil > drempel) {
      masker[p] = 1;
      inhoud++;
    }
  }
  // Geen egale achtergrond: een foto of een druk beeld. Daar is geen veilige
  // inhoudsgrens te trekken.
  if (inhoud / (w * h) > 1 - instelling('GRAPHIC_MIN_ACHTERGROND')) return null;

  // Losse ruispixels (compressie, een stofje) tellen niet: een pixel hoort bij
  // de inhoud als minstens twee buren dat ook doen. Een lijn van één pixel
  // dik (een as, een onderstreping) overleeft dat.
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!masker[y * w + x]) continue;
      let buren = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && masker[(y + dy) * w + x + dx]) buren++;
      if (buren < 2) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const box = { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h };
  if ((box.x1 - box.x0) * (box.y1 - box.y0) > 0.92) return null;
  return box;
}

/** De kleinste box die beide omvat; null blijft null (één onbetrouwbare meting maakt het geheel onbetrouwbaar). */
export function unie(boxen: (Box | null)[]): Box | null {
  if (boxen.length === 0 || boxen.some((b) => b === null)) return null;
  const bs = boxen as Box[];
  return {
    x0: Math.min(...bs.map((b) => b.x0)),
    y0: Math.min(...bs.map((b) => b.y0)),
    x1: Math.max(...bs.map((b) => b.x1)),
    y1: Math.max(...bs.map((b) => b.y1)),
  };
}

/** Meet de inhoudsbox op een reeks brontijden en neemt de unie: animatie die op één frame nog niet in beeld is valt zo niet weg. */
export type InhoudMeter = (tijden: number[]) => Promise<Box | null>;

export function inhoudMeterVia(bron: string): InhoudMeter {
  return async (tijden) => {
    const boxen: (Box | null)[] = [];
    for (const t of tijden) {
      const rgb = await frameRgb(bron, t);
      boxen.push(rgb && rgb.length === MEET_B * MEET_H * 3 ? inhoudsboxUitPixels(rgb, MEET_B, MEET_H) : null);
    }
    return unie(boxen);
  };
}

function frameRgb(bron: string, t: number): Promise<Buffer | null> {
  return new Promise((klaar) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', Math.max(0, t).toFixed(3), '-i', bron, '-frames:v', '1',
        '-vf', `scale=${MEET_B}:${MEET_H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const delen: Buffer[] = [];
    kind.stdout.on('data', (d: Buffer) => delen.push(d));
    kind.on('error', () => klaar(null));
    kind.on('close', (code) => klaar(code === 0 ? Buffer.concat(delen) : null));
  });
}

/**
 * De kadrering van een graphic met gemeten inhoud: welk stuk van de bron (r,
 * genormaliseerd) als voorgrond in beeld komt, en hoe groot (px op 1080x1920).
 *
 * - De inhoud krijgt GRAPHIC_MARGE marge rondom.
 * - Het gebied wordt naar 9:16 uitgebreid zover de bron dat toelaat, zodat er
 *   echte context omheen staat in plaats van blur.
 * - De inzoom is begrensd op GRAPHIC_MAX_OPSCHAAL ten opzichte van een
 *   1080p-bron; een kleinere inhoud krijgt dan een ruimer gebied.
 * - Het gebied bevat per constructie de hele inhoud, en past binnen de bron.
 */
export function inhoudKader(
  box: Box,
  verhouding = 16 / 9,
): { r: Box; fgB: number; fgH: number; y0: number } {
  const marge = instelling('GRAPHIC_MARGE');
  // In eenheden waarin de bronhoogte 1 is en de breedte `verhouding`.
  const bw = (box.x1 - box.x0) * verhouding;
  const bh = box.y1 - box.y0;
  const mx = Math.max(bw, bh) * marge;
  let rw = Math.min(verhouding, bw + 2 * mx);
  let rh = Math.min(1, bh + 2 * mx);
  const doel = 1080 / 1920;
  if (rw / rh > doel) rh = Math.min(1, rw / doel);
  else rw = Math.min(verhouding, rh * doel);

  // Begrenzing van de inzoom: bij een 1080p-bron is één hoogte-eenheid 1080 px.
  const schaal = Math.min(1080 / (rw * 1080), 1920 / (rh * 1080));
  const max = instelling('GRAPHIC_MAX_OPSCHAAL');
  if (schaal > max) {
    const f = schaal / max;
    rw = Math.min(verhouding, rw * f);
    rh = Math.min(1, rh * f);
  }

  // Centreren op de inhoud, binnen de bron gehouden.
  const cx = ((box.x0 + box.x1) / 2) * verhouding;
  const cy = (box.y0 + box.y1) / 2;
  const rx = Math.min(Math.max(cx - rw / 2, 0), verhouding - rw);
  const ry = Math.min(Math.max(cy - rh / 2, 0), 1 - rh);
  const r = { x0: rx / verhouding, y0: ry, x1: (rx + rw) / verhouding, y1: ry + rh };

  const fgB = 2 * Math.floor(Math.min(1080, (1920 * rw) / rh) / 2);
  const fgH = 2 * Math.floor(Math.min(1920, (fgB * rh) / rw) / 2);
  return { r, fgB, fgH, y0: (1920 - fgH) / 2 };
}

/** Waar de inhoud in het eindbeeld staat (fracties van de hoogte). */
export function inhoudOpBeeld(box: Box, verhouding = 16 / 9): { boven: number; onder: number } {
  const k = inhoudKader(box, verhouding);
  const h = k.r.y1 - k.r.y0;
  return {
    boven: (k.y0 + ((box.y0 - k.r.y0) / h) * k.fgH) / 1920,
    onder: (k.y0 + ((box.y1 - k.r.y0) / h) * k.fgH) / 1920,
  };
}

/** Valt een (opnieuw gemeten) inhoudsbox volledig binnen het gerenderde gebied? */
export function boxBinnen(box: Box, r: Box, tolerantie = 0.01): boolean {
  return box.x0 >= r.x0 - tolerantie && box.y0 >= r.y0 - tolerantie && box.x1 <= r.x1 + tolerantie && box.y1 <= r.y1 + tolerantie;
}
