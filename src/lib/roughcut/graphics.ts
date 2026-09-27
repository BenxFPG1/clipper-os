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
 * Box-blur via een integraalbeeld: het gemiddelde over een venster van
 * (2r+1)² pixels, met de randen afgekapt. Snel genoeg voor een paar passes
 * op 480x270.
 */
function boxBlur(bron: Float32Array, w: number, h: number, r: number): Float32Array {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rij = 0;
    for (let x = 0; x < w; x++) {
      rij += bron[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + rij;
    }
  }
  const uit = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      uit[y * w + x] = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
    }
  }
  return uit;
}

/**
 * De inhoudsbox uit één frame (rgb24, w×h).
 *
 * De achtergrond van een merkgraphic is zelden egaal: een verloop, een
 * vignet, een lichtvlek in het midden. Een vaste achtergrondkleur (de
 * mediaan van de rand) zag bij GoldRepublic het hele vlak als "inhoud" en
 * zoomde nooit in. Nu wordt de achtergrond gemodelleerd als een glad
 * oppervlak: een zware blur die de inhoud zelf uitsluit (genormaliseerde
 * convolutie, drie rondes), zodat een verloop wel in het model komt en een
 * cijfer niet. Inhoud is wat daar lokaal sterk van afwijkt, of wat veel
 * scherpe randen heeft (kleine, lichte tekst op een lichte achtergrond).
 *
 * Genegeerd: losse ruispixels, dunne stroken langs de beeldrand (een zwarte
 * rand van de bron) en een klein los element in een bovenhoek (een logo of
 * watermerk) — dat laatste mag buiten beeld vallen, en juist dat logo in de
 * hoek maakte de box anders altijd beeldbreed.
 */
export function inhoudsboxUitPixels(rgb: Buffer | Uint8Array, w: number, h: number): Box | null {
  return analyseerGraphic(rgb, w, h).box;
}

/**
 * Box én een schatting van het aantal leeseenheden (woorden, getallen,
 * grafiekelementen) op de graphic. Geen OCR: elk tekstblok telt naar zijn
 * vorm — een regel tekst van hoogte h en breedte b is ongeveer b / (4h)
 * woorden, een groot getal of een balk is één eenheid. Grof, maar het gaat
 * om de leestijd, niet om de tekst.
 */
export type GraphicAnalyse = {
  box: Box | null;
  woorden: number | null;
  glad?: number;
  /**
   * Aandeel écht vlakke plekken (lokale spreiding in helderheid < 1,5 op
   * 480x270). Een graphic is grotendeels vlak getekend; een camerabeeld heeft
   * overal ruis en textuur. Gemeten: graphics ≥ 0,77, studio-opnames ≤ 0,46.
   */
  vlak: number;
};

/** Lijkt dit beeld op een graphic? "Geen gezicht" alleen is niet genoeg: een wijd camerashot heeft ook geen (gevonden) gezicht. */
export function lijktGraphic(a: { vlak: number } | null | undefined): boolean {
  return Boolean(a) && (a as { vlak: number }).vlak >= instelling('GRAPHIC_MIN_VLAK');
}

function vlakheid(rgb: Buffer | Uint8Array, w: number, h: number): number {
  let vlak = 0;
  let tel = 0;
  for (let y = 2; y < h - 2; y += 2) {
    for (let x = 2; x < w - 2; x += 2) {
      let s = 0;
      let s2 = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const p = ((y + dy) * w + x + dx) * 3;
          const l = 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];
          s += l;
          s2 += l * l;
        }
      }
      const sd = Math.sqrt(Math.max(0, s2 / 25 - (s / 25) ** 2));
      if (sd < 1.5) vlak++;
      tel++;
    }
  }
  return tel ? vlak / tel : 0;
}

export function analyseerGraphic(rgb: Buffer | Uint8Array, w: number, h: number): GraphicAnalyse {
  const vlak = vlakheid(rgb, w, h);
  return { ...analyseerInhoud(rgb, w, h), vlak };
}

function analyseerInhoud(rgb: Buffer | Uint8Array, w: number, h: number): { box: Box | null; woorden: number | null; glad?: number } {
  const drempel = instelling('GRAPHIC_KLEUR_DREMPEL');
  const n = w * h;
  const kanalen = [0, 1, 2].map((c) => {
    const k = new Float32Array(n);
    for (let p = 0; p < n; p++) k[c === 0 ? p : p] = rgb[p * 3 + c];
    return k;
  });

  // Achtergrondmodel: genormaliseerde convolutie, inhoud telt niet mee.
  const r = Math.round(w / 12);
  let gewicht = new Float32Array(n).fill(1);
  let achtergrond: Float32Array[] = kanalen;
  const afwijking = new Float32Array(n);
  for (let ronde = 0; ronde < 3; ronde++) {
    const wb = boxBlur(gewicht, w, h, r);
    achtergrond = kanalen.map((k) => {
      const gewogen = new Float32Array(n);
      for (let p = 0; p < n; p++) gewogen[p] = k[p] * gewicht[p];
      const b = boxBlur(gewogen, w, h, r);
      for (let p = 0; p < n; p++) b[p] = wb[p] > 1e-3 ? b[p] / wb[p] : k[p];
      return b;
    });
    const nieuw = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      afwijking[p] = Math.max(
        Math.abs(kanalen[0][p] - achtergrond[0][p]),
        Math.abs(kanalen[1][p] - achtergrond[1][p]),
        Math.abs(kanalen[2][p] - achtergrond[2][p]),
      );
      nieuw[p] = afwijking[p] < drempel * 0.6 ? 1 : 0;
    }
    gewicht = nieuw;
  }

  // Randen: Sobel op de helderheid. Een verloop heeft vrijwel geen rand, tekst veel.
  const luma = new Float32Array(n);
  for (let p = 0; p < n; p++) luma[p] = 0.299 * kanalen[0][p] + 0.587 * kanalen[1][p] + 0.114 * kanalen[2][p];
  const randDrempel = instelling('GRAPHIC_RAND_DREMPEL');
  const masker = new Uint8Array(n);
  let inhoud = 0;
  // Een smalle band langs de beeldrand telt niet mee: daar zitten
  // compressieranden, zwarte naden en uitsnede-artefacten, die anders een logo
  // in de hoek met de rest van de inhoud verbonden. Echte inhoud tot vlak
  // tegen de rand valt toch binnen beeld: de kadrering zet er marge omheen.
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  for (let y = band; y < h - band; y++) {
    for (let x = band; x < w - band; x++) {
      const p = y * w + x;
      const gx = luma[p - w + 1] + 2 * luma[p + 1] + luma[p + w + 1] - luma[p - w - 1] - 2 * luma[p - 1] - luma[p + w - 1];
      const gy = luma[p + w - 1] + 2 * luma[p + w] + luma[p + w + 1] - luma[p - w - 1] - 2 * luma[p - w] - luma[p - w + 1];
      if (afwijking[p] > drempel || Math.hypot(gx, gy) > randDrempel) {
        masker[p] = 1;
        inhoud++;
      }
    }
  }
  // Een druk beeld (foto, video) wijkt overal af van elk glad model: daar is
  // geen veilige inhoudsgrens te trekken.
  if (inhoud / n > 1 - instelling('GRAPHIC_MIN_ACHTERGROND')) return { box: null, woorden: null };

  // Ruis eruit, dan tekst tot blokken laten samengroeien (een woord is een
  // blok, geen losse letters) en de blokken als componenten tellen.
  const schoon = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (!masker[p]) continue;
      let buren = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && masker[p + dy * w + dx]) buren++;
      if (buren >= 2) schoon[p] = 1;
    }
  }
  const groei = 3;
  const blok = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!schoon[y * w + x]) continue;
      for (let dy = -groei; dy <= groei; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -groei; dx <= groei; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) blok[yy * w + xx] = 1;
        }
      }
    }
  }
  const label = new Int32Array(n).fill(-1);
  const componenten: { x0: number; y0: number; x1: number; y1: number; pixels: number }[] = [];
  const stapel: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!blok[start] || label[start] >= 0) continue;
    const c = { x0: w, y0: h, x1: -1, y1: -1, pixels: 0 };
    const id = componenten.length;
    label[start] = id;
    stapel.push(start);
    while (stapel.length) {
      const p = stapel.pop() as number;
      const x = p % w;
      const y = (p - x) / w;
      if (schoon[p]) {
        c.pixels++;
        if (x < c.x0) c.x0 = x;
        if (x > c.x1) c.x1 = x;
        if (y < c.y0) c.y0 = y;
        if (y > c.y1) c.y1 = y;
      }
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && blok[q] && label[q] < 0) {
          label[q] = id;
          stapel.push(q);
        }
      }
    }
    if (c.x1 >= 0) componenten.push(c);
  }

  const hoek = instelling('GRAPHIC_HOEK');
  const echt = componenten.filter((c) => {
    if (c.pixels < 8) return false;
    const bx0 = c.x0 / w;
    const bx1 = (c.x1 + 1) / w;
    const by0 = c.y0 / h;
    const by1 = (c.y1 + 1) / h;
    // Een dunne strook langs de beeldrand: een zwarte rand of een naad van de bron.
    const langsRand = (bx0 < 0.02 || bx1 > 0.98) && bx1 - bx0 < 0.03;
    const langsBoven = (by0 < 0.02 || by1 > 0.98) && by1 - by0 < 0.03;
    if (langsRand || langsBoven) return false;
    // Een klein los element in een bovenhoek: logo of watermerk. Alleen
    // bovenin: onderin staan bronvermeldingen en voetnoten ("BRON: CBS"), en
    // die mogen nooit wegvallen.
    const inHoek = (bx1 < hoek || bx0 > 1 - hoek) && by1 < hoek;
    if (inHoek && (bx1 - bx0) * (by1 - by0) < 0.02) return false;
    return true;
  });
  const glad = 1 - inhoud / n;
  if (echt.length === 0) return { box: null, woorden: 0, glad };
  const woorden = echt.reduce((t, c) => {
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    return t + Math.max(1, Math.round(bw / (4 * bh)));
  }, 0);
  const box = {
    x0: Math.min(...echt.map((c) => c.x0)) / w,
    y0: Math.min(...echt.map((c) => c.y0)) / h,
    x1: (Math.max(...echt.map((c) => c.x1)) + 1) / w,
    y1: (Math.max(...echt.map((c) => c.y1)) + 1) / h,
  };
  if ((box.x1 - box.x0) * (box.y1 - box.y0) > 0.92) return { box: null, woorden, glad };
  return { box, woorden, glad };
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

/**
 * Box (unie) plus het grootste aantal leeseenheden over de frames (een
 * animatie die tekst laat verschijnen telt volledig), de mediane vlakheid, en
 * — voor een camerabeeld zonder gevonden gezicht — waar het beeld beweegt
 * (horizontaal zwaartepunt van het verschil tussen de frames): de beste
 * schatting van waar de persoon staat.
 */
export type GraphicMeting = {
  box: Box | null;
  woorden: number | null;
  vlak: number;
  persoonX: number | null;
  /** Per meetmoment de box en de vlakheid (in de volgorde van de tijden). */
  boxen?: (Box | null)[];
  vlakken?: number[];
  /**
   * Staat de inhoud stil? Bij een graphic die inanimeert (tekst die later
   * verschijnt, een balk die groeit) verschillen de boxen van begin en eind
   * sterk; dan is er geen veilige inzoom en blijft het passende kader.
   */
  stabiel?: boolean;
};

const oppervlak = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

/** Zijn alle boxen er, en beslaan de eerste én de laatste elk het grootste deel van de unie? */
export function stabieleInhoud(boxen: (Box | null)[]): boolean {
  if (boxen.length === 0 || boxen.some((b) => b === null)) return false;
  const u = unie(boxen);
  if (!u || oppervlak(u) <= 0) return false;
  const min = instelling('GRAPHIC_MIN_STABIEL');
  return oppervlak(boxen[0] as Box) / oppervlak(u) >= min && oppervlak(boxen[boxen.length - 1] as Box) / oppervlak(u) >= min;
}
export type GraphicMeter = (tijden: number[]) => Promise<GraphicMeting>;

export function graphicMeterVia(bron: string): GraphicMeter {
  return async (tijden) => {
    const boxen: (Box | null)[] = [];
    const woorden: number[] = [];
    const vlak: number[] = [];
    const frames: Buffer[] = [];
    for (const t of tijden) {
      const rgb = await frameRgb(bron, t);
      const geldig = rgb && rgb.length === MEET_B * MEET_H * 3;
      const a = geldig ? analyseerGraphic(rgb, MEET_B, MEET_H) : { box: null, woorden: null, vlak: 0 };
      if (geldig) frames.push(rgb);
      boxen.push(a.box);
      if (a.woorden !== null) woorden.push(a.woorden);
      vlak.push(a.vlak);
    }
    const mediaanVlak = [...vlak].sort((a, b) => a - b)[Math.floor(vlak.length / 2)] ?? 0;
    return {
      box: unie(boxen),
      woorden: woorden.length ? Math.max(...woorden) : null,
      vlak: mediaanVlak,
      persoonX: bewegingX(frames),
      boxen,
      vlakken: vlak,
      stabiel: stabieleInhoud(boxen),
    };
  };
}

/** Horizontaal zwaartepunt van wat er tussen de frames beweegt; null als er (bijna) niets beweegt. */
export function bewegingX(frames: Buffer[]): number | null {
  if (frames.length < 2) return null;
  let som = 0;
  let gewicht = 0;
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f - 1];
    const b = frames[f];
    for (let y = 0; y < MEET_H; y += 2) {
      for (let x = 0; x < MEET_B; x += 2) {
        const p = (y * MEET_B + x) * 3;
        const d = Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
        if (d > 45) {
          som += (x / MEET_B) * d;
          gewicht += d;
        }
      }
    }
  }
  return gewicht > 2000 ? Math.round((som / gewicht) * 1000) / 1000 : null;
}

export function inhoudMeterVia(bron: string): InhoudMeter {
  const meter = graphicMeterVia(bron);
  return async (tijden) => (await meter(tijden)).box;
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
