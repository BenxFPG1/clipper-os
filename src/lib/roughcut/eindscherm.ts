import { spawn, spawnSync } from 'node:child_process';
import { resolveBinary } from '../ingest/binaries';
import { instelling } from './instellingen';
import { uitsnedeVan } from './kadercontrole';
import { basisZoom, type Shot } from './index';
import { deelstukken } from './scenes';
import type { Box } from './graphics';
import type { Kader } from './kader';
import type { KeuringRegel } from './keuring';
import type { BronWoord } from './woorden';
import { verzetGrens } from './poort';

/**
 * YouTube-eindscherm en abonneer-animaties uit beeld houden.
 *
 * In de laatste halve minuut van een YouTube-video staan vaak de rode
 * "SUBSCRIBE"-knop, een duim en een bel over de spreker heen. In een clip is
 * dat vreemd materiaal: het hoort bij een ander platform en roept de kijker
 * weg. Detectie is goedkoop en gericht: een massieve, fel verzadigd rode
 * rechthoek in de onderste helft (de knop), met de iconen en tekst eromheen.
 * Daarna het kader zo kiezen dat de overlay erbuiten valt (inzoomen en de
 * uitsnede boven de knop leggen); lukt dat niet zonder het gezicht aan te
 * snijden, dan het shot inkorten tot vóór de overlay verschijnt, en anders
 * meldt de keuring het.
 */

const B = 320;
const H = 180;

/** De overlay-box (genormaliseerd) uit één frame, of null. */
export function overlayUitPixels(rgb: Buffer | Uint8Array, w: number, h: number): Box | null {
  const rood = new Uint8Array(w * h);
  for (let y = Math.floor(h * 0.45); y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 3;
      const r = rgb[p];
      const g = rgb[p + 1];
      const b = rgb[p + 2];
      // YouTube-rood (#FF0000-achtig): heel rood, bijna geen groen of blauw.
      // Rood haar en huid hebben duidelijk meer groen.
      if (r > 170 && g < 70 && b < 80 && r - g > 120) rood[y * w + x] = 1;
    }
  }
  // Componenten; de knop is massief, breder dan hoog, en niet piepklein.
  const label = new Int32Array(w * h).fill(-1);
  let beste: { x0: number; y0: number; x1: number; y1: number; n: number } | null = null;
  for (let start = 0; start < w * h; start++) {
    if (!rood[start] || label[start] >= 0) continue;
    const c = { x0: w, y0: h, x1: -1, y1: -1, n: 0 };
    const stapel = [start];
    label[start] = 1;
    while (stapel.length) {
      const p = stapel.pop() as number;
      const x = p % w;
      const y = (p - x) / w;
      c.n++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && rood[q] && label[q] < 0) {
          label[q] = 1;
          stapel.push(q);
        }
      }
    }
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    const vulling = c.n / (bw * bh);
    if (c.n / (w * h) < 0.003 || vulling < 0.6 || bw / bh < 1.4 || bw / bh > 8) continue;
    if (!beste || c.n > beste.n) beste = c;
  }
  if (!beste) return null;
  // De knop plus de iconen en tekst eromheen (duim links, bel rechts, tekst eronder).
  const bw = (beste.x1 - beste.x0 + 1) / w;
  const bh = (beste.y1 - beste.y0 + 1) / h;
  return {
    x0: Math.max(0, beste.x0 / w - 1.5 * bw),
    y0: Math.max(0, beste.y0 / h - 0.8 * bh),
    x1: Math.min(1, (beste.x1 + 1) / w + 1.5 * bw),
    y1: Math.min(1, (beste.y1 + 1) / h + 2 * bh),
  };
}

function frame(bron: string, t: number): Promise<Buffer | null> {
  return new Promise((klaar) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', Math.max(0, t).toFixed(3), '-i', bron, '-frames:v', '1',
        '-vf', `scale=${B}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const delen: Buffer[] = [];
    kind.stdout.on('data', (d: Buffer) => delen.push(d));
    kind.on('error', () => klaar(null));
    kind.on('close', (code) => klaar(code === 0 ? Buffer.concat(delen) : null));
  });
}

export type OverlayMeter = (tijden: number[]) => Promise<(Box | null)[]>;

export function overlayMeterVia(bron: string): OverlayMeter {
  return async (tijden) => {
    const uit: (Box | null)[] = [];
    for (const t of tijden) {
      const rgb = await frame(bron, t);
      uit.push(rgb && rgb.length === B * H * 3 ? overlayUitPixels(rgb, B, H) : null);
    }
    return uit;
  };
}

/** Duur van de bron (s) via ffprobe; null als onbekend. */
export function bronDuur(pad: string): number | null {
  const r = spawnSync(resolveBinary('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', pad], {
    encoding: 'utf8',
  });
  const n = Number((r.stdout ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Kadreer zó dat de overlay erbuiten valt: inzoomen tot de uitsnede boven de
 * overlay past, en de uitsnede daar neerleggen. Kan alleen als het gezicht
 * boven de overlay eindigt en de benodigde zoom binnen ZOOM_MAX blijft.
 * Levert of het lukte; muteert zoom en focusY.
 */
export function vermijdOverlay(seg: Shot): boolean {
  const o = seg.overlay;
  if (!o) return true;
  const marge = 0.02;
  const bovenOverlay = o.y0 - marge;
  if (bovenOverlay <= 0.2) return false;
  const g = seg.gezicht;
  if (g && g.top + g.hoogte > bovenOverlay - 0.01) return false; // de kin staat al in de overlay
  const zMin = 1 / bovenOverlay;
  if (zMin > instelling('ZOOM_MAX')) return false;
  const z = Math.max(zMin, seg.zoom ?? basisZoom(seg));
  // De uitsnede met zijn onderrand net boven de overlay.
  let y0 = bovenOverlay - 1 / z;
  if (g && g.top < y0 + 0.02) {
    // Te ver ingezoomd om kruin én overlay te halen: terug naar de minimale zoom.
    y0 = bovenOverlay - 1 / zMin;
    seg.zoom = Math.round(zMin * 1000) / 1000;
  } else {
    seg.zoom = Math.round(z * 1000) / 1000;
  }
  seg.focusY = Math.round((y0 + 1 / (2 * (seg.zoom ?? z))) * 1000) / 1000;
  seg.spoorY = undefined;
  return true;
}

/**
 * Meet de overlay in shots die in de laatste EINDSCHERM_VENSTER seconden van
 * de bron vallen, en grijpt in: vermijden via het kader, anders inkorten tot
 * vóór de overlay (op een woordgrens), anders laten staan voor de keuring.
 */
export async function behandelEindscherm(
  segmenten: Shot[],
  opties: { bronDuur: number | null; meter: OverlayMeter; bronWoorden?: BronWoord[] | null },
): Promise<{ gemeten: number; vermeden: number; ingekort: number; niet: number; regels: string[] }> {
  const uit = { gemeten: 0, vermeden: 0, ingekort: 0, niet: 0, regels: [] as string[] };
  if (!opties.bronDuur) return uit;
  const grens = opties.bronDuur - instelling('EINDSCHERM_VENSTER');
  for (const seg of segmenten) {
    if (seg.end < grens) continue;
    uit.gemeten++;
    const tijden: number[] = [];
    for (let t = Math.max(seg.start, grens) + 0.2; t < seg.end; t += 1) tijden.push(Math.round(t * 100) / 100);
    const metingen = await opties.meter(tijden);
    const gevonden = metingen.map((b, i) => ({ b, t: tijden[i] })).filter((x) => x.b);
    if (gevonden.length === 0) continue;
    const box = gevonden.reduce<Box>(
      (u, x) => ({ x0: Math.min(u.x0, x.b!.x0), y0: Math.min(u.y0, x.b!.y0), x1: Math.max(u.x1, x.b!.x1), y1: Math.max(u.y1, x.b!.y1) }),
      gevonden[0].b!,
    );
    seg.overlay = box;
    if (vermijdOverlay(seg)) {
      uit.vermeden++;
      uit.regels.push(`shot ${seg.volgorde}: eindscherm op ${gevonden[0].t.toFixed(1)} s → ingezoomd tot ${seg.zoom?.toFixed(2)} boven de overlay`);
      continue;
    }
    // Inkorten tot vóór de overlay: op het laatste woordeinde ervoor.
    const begin = gevonden[0].t - 1;
    const woord = (opties.bronWoorden ?? []).filter((w) => w.e <= begin && w.e > seg.start + 1).pop();
    const nieuwEind = woord ? woord.e + 0.1 : begin;
    if (nieuwEind - seg.start >= 1.5) {
      verzetGrens(seg, { end: nieuwEind });
      seg.overlay = undefined;
      uit.ingekort++;
      uit.regels.push(`shot ${seg.volgorde}: eindscherm vanaf ${gevonden[0].t.toFixed(1)} s niet uit beeld te kadreren → ingekort tot ${nieuwEind.toFixed(2)} s`);
    } else {
      uit.niet++;
      uit.regels.push(`shot ${seg.volgorde}: eindscherm niet te vermijden (review)`);
    }
  }
  return uit;
}

/** Keuringsregel "geen eindscherm/overlay": geen gemeten overlay binnen de uitsnede die de render neemt. */
export function keurOverlay(segmenten: Shot[], kader: Kader): KeuringRegel {
  const naam = 'geen eindscherm/overlay';
  const fouten: string[] = [];
  let getoetst = 0;
  for (const seg of segmenten) {
    const o = seg.overlay;
    if (!o) continue;
    getoetst++;
    const delen = deelstukken(seg, kader);
    if (delen.some((d) => d.kader !== 'vullend' && d.kader !== 'staand')) {
      fouten.push(`shot ${seg.volgorde}: overlay in beeld (passend kader toont het hele beeld)`);
      continue;
    }
    const paneelBreed = seg.paneel ? seg.paneel[1] - seg.paneel[0] : 1;
    const u = uitsnedeVan(seg.focusX ?? 0.5, seg.zoom ?? basisZoom(seg), seg.focusY ?? 0.5, (16 / 9) * paneelBreed);
    const overlapt = u.y1 > o.y0 + 0.01 && u.x1 > o.x0 && u.x0 < o.x1;
    if (overlapt) fouten.push(`shot ${seg.volgorde}: eindscherm-overlay valt in de uitsnede (onder ${Math.round(o.y0 * 100)}% hoogte)`);
  }
  return {
    naam,
    goed: fouten.length === 0,
    detail: fouten.length === 0 ? (getoetst ? `${getoetst} shot(s) met eindscherm, overlay overal buiten beeld` : 'geen eindscherm in beeld') : fouten.join('; '),
  };
}
