import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { resolveBinary } from '../ingest/binaries';
import { instelling, ondertitelFontStandaard } from './instellingen';
import { FONTS, fontVoor, veiligeTekst, type Huisstijl } from './tekstkaarten';
import { basisZoom, type BurnOverlay, type Shot } from './index';
import { uitsnedeVan } from './kadercontrole';
import { deelstukken } from './scenes';
import type { Kader } from './kader';
import type { BronWoord } from './woorden';

/**
 * Ondertitels op woordniveau, ingebrand in de mp4.
 *
 * Waarom dit de grootste kwaliteitswinst is: short-form wordt grotendeels
 * zonder geluid gekeken, en de clips hadden tot nu toe géén tekst behalve de
 * hookkaart (2,6 s) en een enkele tijdsprongkaart. De brontranscriptie met
 * woordtijden ligt er al (gecached per video, dezelfde waarheid als de poort
 * gebruikt), dus de ondertitels zijn exact op het woord — geen rollende
 * YouTube-blokken van acht seconden meer.
 *
 * Twee uitvoerwegen, één inhoud:
 *  - ASS via het `ass=`-filter van ffmpeg (libass): per regel 2-4 woorden,
 *    het actieve woord in de accentkleur van de huisstijl. Dat is de weg op
 *    de runner (apt-ffmpeg heeft libass).
 *  - PNG-overlays via de tekenbibliotheek als deze ffmpeg-bouw geen libass
 *    heeft (de Mac-bouw hier heeft geen tekstfilter): dezelfde regels, zonder
 *    actief-woord-kleur. Beter dan geen ondertitels.
 *
 * Stijl: een eigen ondertitelstijl, los van het kaartfont. Het merkfont
 * volgen gaf op een campagne met Playfair een dunne schreef van 35 px
 * kapitaalhoogte — onleesbaar op een telefoon. Nu: een dikke, statische
 * schreefloze letter (standaard Archivo Black; statisch omdat libass bij een
 * variabel font de standaardinstantie pakt, niet het gewicht dat je noemt),
 * kapitaalhoogte ONDERTITEL_KAPHOOGTE, dikke zwarte rand en zachte schaduw,
 * het actieve woord in de accentkleur van de huisstijl.
 *
 * Positie: per regel gekozen op de gemeten gezichtspositie. Standaard rond
 * ONDERTITEL_Y; staat de kin daar, dan eronder; nooit onder ONDERTITEL_Y_MAX
 * (daar zit de platform-UI). Past het onder de kin niet, dan boven het hoofd.
 */

export type OndertitelWoord = { w: string; s: number; e: number };
export type OndertitelRegel = { s: number; e: number; woorden: OndertitelWoord[] };

const B = 1080;
const H = 1920;

/** Het font dat de ondertitels gebruiken: de override uit de huisstijl, anders de vaste ondertitelletter. */
export function ondertitelFont(stijl?: Huisstijl | null): { sleutel: string; familie: string; bestand: string } {
  const sleutel = [stijl?.ondertitel_font, ondertitelFontStandaard(), 'archivo'].find((k) => k && FONTS[k]) as string;
  fontVoor(null); // registreert de fonts voor de tekenbibliotheek
  return { sleutel, familie: FONTS[sleutel].familie, bestand: FONTS[sleutel].bestand };
}

type FontMaat = { upem: number; winAsc: number; winDesc: number; kap: number };
const maatCache = new Map<string, FontMaat>();

/**
 * De verticale maten uit het fontbestand zelf (head en OS/2). Nodig om een
 * kapitaalhoogte in pixels om te rekenen naar een ASS-fontgrootte: libass
 * schaalt zo dat winAscent + winDescent de opgegeven grootte is, en de
 * verhouding kapitaal/regelhoogte verschilt per font sterk.
 */
export function fontMaat(bestand: string): FontMaat {
  const hit = maatCache.get(bestand);
  if (hit) return hit;
  const pad = join(process.cwd(), 'assets', 'fonts', bestand);
  let maat: FontMaat = { upem: 1000, winAsc: 1000, winDesc: 250, kap: 700 };
  try {
    const buf = readFileSync(pad);
    const tabellen = buf.readUInt16BE(4);
    let head = -1;
    let os2 = -1;
    for (let i = 0; i < tabellen; i++) {
      const r = 12 + i * 16;
      const tag = buf.toString('latin1', r, r + 4);
      const offset = buf.readUInt32BE(r + 8);
      if (tag === 'head') head = offset;
      if (tag === 'OS/2') os2 = offset;
    }
    const upem = head >= 0 ? buf.readUInt16BE(head + 18) : 1000;
    if (os2 >= 0) {
      const versie = buf.readUInt16BE(os2);
      const kap = versie >= 2 ? buf.readInt16BE(os2 + 88) : 0;
      maat = { upem, winAsc: buf.readUInt16BE(os2 + 74), winDesc: buf.readUInt16BE(os2 + 76), kap: kap > 0 ? kap : upem * 0.7 };
    }
  } catch {
    // Onleesbaar bestand: de terugvalmaten zijn die van een gemiddelde schreefloze letter.
  }
  maatCache.set(bestand, maat);
  return maat;
}

/** ASS-fontgrootte en em-grootte (px) voor de ingestelde kapitaalhoogte. */
export function ondertitelMaat(stijl?: Huisstijl | null): { assGrootte: number; emPx: number; kapPx: number } {
  const font = ondertitelFont(stijl);
  const m = fontMaat(font.bestand);
  const kapPx = instelling('ONDERTITEL_KAPHOOGTE');
  return {
    assGrootte: Math.round((kapPx * (m.winAsc + m.winDesc)) / m.kap),
    emPx: Math.round((kapPx * m.upem) / m.kap),
    kapPx,
  };
}

/**
 * De woorden van de bron die in de gerenderde segmenten klinken, omgerekend
 * naar de tijdlijn van de montage. Segmenten staan al in montagevolgorde.
 */
export function woordenOpTijdlijn(segmenten: Shot[], bronWoorden: BronWoord[]): OndertitelWoord[] {
  const uit: OndertitelWoord[] = [];
  let cursor = 0;
  for (const seg of segmenten) {
    const duur = seg.end - seg.start;
    for (const w of bronWoorden) {
      if (w.s < seg.start - 0.05) continue;
      if (w.s > seg.end) break;
      // Een woord dat over de knip heen loopt wordt afgekapt op het segment;
      // de poort zorgt dat dat vrijwel niet voorkomt.
      const s = cursor + Math.max(0, w.s - seg.start);
      const e = cursor + Math.min(duur, Math.max(w.e - seg.start, w.s - seg.start + 0.08));
      if (e <= s) continue;
      const tekst = veiligeTekst(w.w).replace(/\s+/g, '');
      if (!tekst) continue;
      uit.push({ w: tekst, s, e });
    }
    cursor += duur;
  }
  return uit;
}

/**
 * Woorden groeperen tot regels: hoogstens `ONDERTITEL_MAX_WOORDEN` woorden of
 * `ONDERTITEL_MAX_TEKENS` tekens, en een nieuwe regel na een pauze — een
 * regel die over een adempauze heen hangt leest als een fout.
 */
export function groepeerRegels(woorden: OndertitelWoord[]): OndertitelRegel[] {
  const maxWoorden = instelling('ONDERTITEL_MAX_WOORDEN');
  const maxTekens = instelling('ONDERTITEL_MAX_TEKENS');
  const breekPauze = instelling('ONDERTITEL_BREEK_PAUZE');
  const regels: OndertitelRegel[] = [];
  let huidig: OndertitelWoord[] = [];

  const sluit = () => {
    if (huidig.length === 0) return;
    regels.push({ s: huidig[0].s, e: huidig[huidig.length - 1].e, woorden: huidig });
    huidig = [];
  };

  for (const w of woorden) {
    const vorige = huidig[huidig.length - 1];
    const tekens = huidig.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
    const pauze = vorige ? w.s - vorige.e : 0;
    if (huidig.length >= maxWoorden || (huidig.length > 0 && tekens > maxTekens) || pauze > breekPauze) sluit();
    huidig.push(w);
    // Een zinseinde is een natuurlijke regelgrens, ook bij een korte regel.
    if (/[.!?]$/.test(w.w) && huidig.length >= 2) sluit();
  }
  sluit();

  // Elke regel blijft staan tot de volgende begint (tot een korte pauze), zodat
  // de tekst niet knippert tussen woorden.
  for (let i = 0; i < regels.length; i++) {
    const volgende = regels[i + 1];
    const plafond = volgende ? volgende.s - 0.02 : regels[i].e + 0.4;
    regels[i].e = Math.max(regels[i].e, Math.min(plafond, regels[i].e + 0.4));
  }
  return regels;
}

/** #RRGGBB naar de ASS-notatie &H00BBGGRR&. */
function assKleur(hex: string | null | undefined, terugval = '&H00FFFFFF&'): string {
  const m = (hex ?? '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return terugval;
  const [r, g, b] = [0, 2, 4].map((i) => m[1].slice(i, i + 2));
  return `&H00${b}${g}${r}&`.toUpperCase();
}

function assTijd(seconden: number): string {
  const cs = Math.max(0, Math.round(seconden * 100));
  const u = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${u}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/**
 * Het ASS-bestand: één Dialogue-regel per actief woord, met de hele regel in
 * beeld en het actieve woord in de accentkleur. Zo staat de tekst stil en
 * loopt alleen de kleur mee met de stem. `plaatsing` is per regel de
 * onderrand in px (anker onder-midden); zonder plaatsing de standaardhoogte.
 */
export function bouwAss(regels: OndertitelRegel[], stijl?: Huisstijl | null, plaatsing?: number[]): string {
  const font = ondertitelFont(stijl);
  const maat = ondertitelMaat(stijl);
  const accent = assKleur(stijl?.accent, '&H0000D7FF&'); // geel als er geen huisstijl is
  const wit = '&H00FFFFFF&';
  const standaardOnder = standaardOnderrand(maat.assGrootte);
  const kop = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Bold 0: het font is zelf al zwaar; libass zou er anders een nep-vet
    // overheen rekenen dat de letters dichtslibt. Schaduw half doorzichtig.
    `Style: Woord,${font.familie},${maat.assGrootte},${wit},${wit},&H00000000&,&H90000000&,0,0,0,0,100,100,0,0,1,${instelling('ONDERTITEL_RAND')},${instelling('ONDERTITEL_SCHADUW')},2,60,60,${Math.round(H - standaardOnder)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const veilig = (t: string) => t.replace(/[{}\\]/g, '').replace(/\n/g, ' ');
  const dialogen: string[] = [];
  regels.forEach((regel, r) => {
    const y = Math.round(plaatsing?.[r] ?? standaardOnder);
    // Te breed voor het beeld? Dan kleiner, niet afbreken: een regel die
    // halverwege een woordgroep naar een tweede regel springt leest slecht.
    const breedte = regelBreedte(regel.woorden.map((w) => w.w).join(' '), stijl);
    const schaal = breedte > instelling('ONDERTITEL_MAX_BREEDTE') ? Math.floor((instelling('ONDERTITEL_MAX_BREEDTE') / breedte) * 100) : 100;
    const opmaak = `{\\an2\\pos(540,${y})${schaal < 100 ? `\\fscx${schaal}\\fscy${schaal}` : ''}}`;
    regel.woorden.forEach((woord, k) => {
      const van = woord.s;
      const tot = k + 1 < regel.woorden.length ? regel.woorden[k + 1].s : regel.e;
      if (tot - van < 0.01) return;
      const tekst = regel.woorden
        .map((x, i) => (i === k ? `{\\c${accent}}${veilig(x.w)}{\\c${wit}}` : veilig(x.w)))
        .join(' ');
      dialogen.push(`Dialogue: 0,${assTijd(van)},${assTijd(tot)},Woord,,0,0,0,,${opmaak}${tekst}`);
    });
  });
  return `${kop.join('\n')}\n${dialogen.join('\n')}\n`;
}

/** Onderrand (px) van een regel op de standaardhoogte: het regelmidden op ONDERTITEL_Y. */
function standaardOnderrand(assGrootte: number): number {
  return Math.min(instelling('ONDERTITEL_Y_MAX') * H, instelling('ONDERTITEL_Y') * H + assGrootte / 2);
}

/** Breedte van een regel in px, gemeten met hetzelfde font als libass straks gebruikt. */
function regelBreedte(tekst: string, stijl?: Huisstijl | null): number {
  const font = ondertitelFont(stijl);
  const maat = ondertitelMaat(stijl);
  const ctx = createCanvas(10, 10).getContext('2d');
  ctx.font = `${maat.emPx}px "${font.familie}", "Helvetica Neue", Arial, sans-serif`;
  return ctx.measureText(tekst).width + 2 * instelling('ONDERTITEL_RAND');
}

export type Plek = 'standaard' | 'onder_kin' | 'boven_hoofd' | 'overlap';

/**
 * Waar het gezicht op dit brontijdstip in het eindbeeld staat (fracties van
 * de hoogte), of null als er geen gezicht is (een graphic-deelstuk, geen
 * meting). Zelfde uitsnede-rekenwerk als de kadercontrole en de keuring.
 */
export function gezichtOpBeeld(seg: Shot, kader: Kader, t: number): { boven: number; onder: number } | null {
  const g = seg.gezicht;
  if (!g) return null;
  const rel = t - seg.start;
  const deel = deelstukken(seg, kader).find((d) => rel >= d.van && rel <= d.tot) ?? deelstukken(seg, kader)[0];
  if (deel.gezicht === false || deel.kader === 'origineel') return null;
  if (deel.kader === 'blur') {
    // Passend: het hele 16:9-beeld op volle breedte, verticaal in het midden.
    const hoogte = B * (9 / 16);
    const top = (H - hoogte) / 2;
    return { boven: (top + g.top * hoogte) / H, onder: (top + (g.top + g.hoogte) * hoogte) / H };
  }
  const paneelBreed = seg.paneel ? seg.paneel[1] - seg.paneel[0] : 1;
  const spoorY = seg.spoorY?.length
    ? seg.spoorY.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)).x
    : seg.focusY;
  const u = uitsnedeVan(0.5, seg.zoom ?? basisZoom(seg), spoorY ?? 0.5, (16 / 9) * paneelBreed);
  const h = u.y1 - u.y0;
  return { boven: (g.top - u.y0) / h, onder: (g.top + g.hoogte - u.y0) / h };
}

/**
 * De onderrand (px) per regel: standaard rond ONDERTITEL_Y, onder de kin als
 * het gezicht daar zit, nooit onder ONDERTITEL_Y_MAX; past het niet onder de
 * kin, dan boven het hoofd (als dat niet in de hookzone valt), en anders op
 * de onderste toegestane plek met de overlap benoemd.
 */
export function plaatsRegels(
  regels: OndertitelRegel[],
  segmenten: Shot[],
  kader: Kader,
  stijl?: Huisstijl | null,
): { plaatsing: number[]; plekken: Plek[] } {
  const regelH = ondertitelMaat(stijl).assGrootte;
  const marge = instelling('ONDERTITEL_KIN_MARGE') * H;
  const maxOnder = instelling('ONDERTITEL_Y_MAX') * H;
  const minBoven = instelling('ONDERTITEL_Y_MIN_BOVEN') * H;
  const standaard = standaardOnderrand(regelH);
  const begin: number[] = [];
  let cursor = 0;
  for (const seg of segmenten) {
    begin.push(cursor);
    cursor += seg.end - seg.start;
  }
  const plaatsing: number[] = [];
  const plekken: Plek[] = [];
  for (const regel of regels) {
    // Het gezicht op een paar momenten binnen de regel: begin, midden, eind.
    let boven = Infinity;
    let onder = -Infinity;
    for (const t of [regel.s + 0.05, (regel.s + regel.e) / 2, regel.e - 0.05]) {
      const i = begin.findIndex((b, k) => t >= b && t < b + (segmenten[k].end - segmenten[k].start));
      if (i < 0) continue;
      const g = gezichtOpBeeld(segmenten[i], kader, segmenten[i].start + (t - begin[i]));
      if (!g) continue;
      boven = Math.min(boven, g.boven * H);
      onder = Math.max(onder, g.onder * H);
    }
    const botst = (y: number) => onder > -Infinity && y - regelH < onder + marge && y > boven - marge;
    let y = standaard;
    let plek: Plek = 'standaard';
    if (botst(y)) {
      const onderKin = onder + marge + regelH;
      if (onderKin <= maxOnder) {
        y = Math.max(standaard, onderKin);
        plek = 'onder_kin';
      } else if (boven - marge - regelH >= minBoven) {
        y = boven - marge;
        plek = 'boven_hoofd';
      } else {
        y = maxOnder;
        plek = 'overlap';
      }
    }
    plaatsing.push(Math.round(Math.min(maxOnder, y)));
    plekken.push(plek);
  }
  return { plaatsing, plekken };
}

/** SRT uit dezelfde regels, voor de download naast de mp4. */
export function bouwSrtUitRegels(regels: OndertitelRegel[]): string {
  const tijd = (seconden: number) => {
    const ms = Math.max(0, Math.round(seconden * 1000));
    const p = (n: number, l = 2) => String(n).padStart(l, '0');
    return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor((ms % 3_600_000) / 60_000))}:${p(Math.floor((ms % 60_000) / 1000))},${p(ms % 1000, 3)}`;
  };
  return regels
    .map((r, i) => `${i + 1}\n${tijd(r.s)} --> ${tijd(r.e)}\n${r.woorden.map((w) => w.w).join(' ')}\n`)
    .join('\n');
}

let assBeschikbaar: boolean | null = null;

/** Heeft deze ffmpeg-bouw libass (het `ass`-filter)? Eén keer meten. */
export function heeftAssFilter(): boolean {
  if (assBeschikbaar !== null) return assBeschikbaar;
  const res = spawnSync(resolveBinary('ffmpeg'), ['-hide_banner', '-filters'], { encoding: 'utf8' });
  assBeschikbaar = /^\s*[A-Z.]+\s+ass\s+/m.test(res.stdout ?? '');
  return assBeschikbaar;
}

/**
 * Een pad veilig maken voor gebruik ín een filtergraph-optie: de graph-parser
 * ziet `:`, `,`, `;`, `[`, `]`, `'` en `\` als syntaxis.
 */
export function filterPad(pad: string): string {
  return pad.replace(/([\\:,;'\[\]])/g, '\\$1');
}

/** Het ffmpeg-filter dat het ASS-bestand inbrandt, mét de merkfonts. */
export function assFilter(assPad: string): string {
  const fontsdir = join(process.cwd(), 'assets', 'fonts');
  return `ass=${filterPad(assPad)}:fontsdir=${filterPad(fontsdir)}`;
}

/** Terugval zonder libass: één PNG per regel, zelfde plek, font en grootte. */
async function tekenRegelPng(tekst: string, pad: string, yOnder: number, stijl?: Huisstijl | null): Promise<void> {
  const font = ondertitelFont(stijl);
  const maat = ondertitelMaat(stijl);
  const m = fontMaat(font.bestand);
  const canvas = createCanvas(B, H);
  const ctx = canvas.getContext('2d');
  const breedte = regelBreedte(tekst, stijl);
  const schaal = Math.min(1, instelling('ONDERTITEL_MAX_BREEDTE') / breedte);
  const em = maat.emPx * schaal;
  ctx.font = `${em}px "${font.familie}", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  // Zelfde anker als in ASS: yOnder is de onderkant van de regel, de
  // basislijn ligt daar de daalhoogte boven.
  const y = yOnder - (em * m.winDesc) / m.upem;
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowOffsetX = instelling('ONDERTITEL_SCHADUW');
  ctx.shadowOffsetY = instelling('ONDERTITEL_SCHADUW');
  ctx.lineWidth = instelling('ONDERTITEL_RAND') * 2;
  ctx.strokeStyle = '#000000';
  ctx.strokeText(tekst, B / 2, y);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(tekst, B / 2, y);
  await writeFile(pad, canvas.toBuffer('image/png'));
}

export type Ondertitels = {
  regels: OndertitelRegel[];
  /** Voor de kwaliteitsregel in de log: font, grootte en waar de regels terechtkwamen. */
  stijl: { familie: string; bestand: string; assGrootte: number; kapPx: number; plekken: Record<Plek, number> };
  /** Pad naar het ASS-bestand; alleen gezet als ffmpeg het kan inbranden. */
  assPad?: string;
  /** PNG-overlays als terugval zonder libass. */
  overlays: BurnOverlay[];
  srt: string;
};

/**
 * Bouwt de ondertitels voor één clip: regels uit de bronwoorden, en óf een
 * ASS-bestand óf PNG-overlays, afhankelijk van wat ffmpeg hier kan.
 */
export async function maakOndertitels(
  segmenten: Shot[],
  bronWoorden: BronWoord[],
  map: string,
  voorvoegsel: string,
  stijl?: Huisstijl | null,
  opties: { kader?: Kader } = {},
): Promise<Ondertitels> {
  const regels = groepeerRegels(woordenOpTijdlijn(segmenten, bronWoorden));
  const srt = bouwSrtUitRegels(regels);
  const font = ondertitelFont(stijl);
  const maat = ondertitelMaat(stijl);
  const { plaatsing, plekken } = plaatsRegels(regels, segmenten, opties.kader ?? 'vullend', stijl);
  const telling: Record<Plek, number> = { standaard: 0, onder_kin: 0, boven_hoofd: 0, overlap: 0 };
  for (const p of plekken) telling[p]++;
  const stijlInfo = { familie: font.familie, bestand: font.bestand, assGrootte: maat.assGrootte, kapPx: maat.kapPx, plekken: telling };
  if (regels.length === 0) return { regels, overlays: [], srt, stijl: stijlInfo };

  if (heeftAssFilter()) {
    const assPad = join(map, `${voorvoegsel}-ondertitels.ass`);
    await writeFile(assPad, bouwAss(regels, stijl, plaatsing));
    return { regels, assPad, overlays: [], srt, stijl: stijlInfo };
  }

  const overlays: BurnOverlay[] = [];
  for (const [i, regel] of regels.entries()) {
    const pad = join(map, `${voorvoegsel}-ot-${String(i).padStart(3, '0')}.png`);
    await tekenRegelPng(regel.woorden.map((w) => w.w).join(' '), pad, plaatsing[i], stijl);
    overlays.push({ pad, start: regel.s, end: regel.e });
  }
  return { regels, overlays, srt, stijl: stijlInfo };
}

/**
 * Welk fontbestand libass werkelijk kiest voor de ondertitelstijl. Een
 * familienaam die libass niet vindt valt stil terug op een systeemfont — en
 * dan ziet de clip er anders uit dan bedoeld zonder dat iemand het merkt.
 * Eén frame renderen met een proefregel en de fontselect-melding lezen.
 */
export function controleerAssFont(map: string, stijl?: Huisstijl | null): { familie: string; bestand: string; goed: boolean } | null {
  if (!heeftAssFilter()) return null;
  const font = ondertitelFont(stijl);
  const proef = join(map, 'fontproef.ass');
  const ass = bouwAss([{ s: 0, e: 1, woorden: [{ w: 'Proef', s: 0, e: 1 }] }], stijl);
  try {
    writeFileSync(proef, ass);
  } catch {
    return null;
  }
  const res = spawnSync(
    resolveBinary('ffmpeg'),
    ['-hide_banner', '-loglevel', 'verbose', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:d=0.5', '-vf', assFilter(proef), '-frames:v', '1', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  // libass meldt "fontselect: (familie, gewicht, cursief) -> pad-of-naam,
  // index, postscriptnaam". Bij fonts uit fontsdir is dat eerste deel niet
  // altijd een pad maar soms de postscriptnaam ("ArchivoBlack-Regular"): de
  // vergelijking met de bestandsnaam gaf dan een valse waarschuwing. Nu telt
  // een match op bestandsnaam óf postscriptnaam, zonder map en extensie.
  const m = `${res.stdout}${res.stderr}`.match(/fontselect:\s*\(([^,]+),[^)]*\)\s*->\s*([^,\n]+?)\s*,\s*\d+\s*,\s*([^\s,]+)/);
  if (!m) return { familie: font.familie, bestand: '(geen fontselect-melding)', goed: false };
  const gekozen = m[2].trim().split('/').pop() ?? m[2];
  return { familie: m[1].trim(), bestand: gekozen, goed: fontKlopt(font, gekozen, m[3]) };
}

/** Is het door libass gekozen font (pad of naam, plus postscriptnaam) het bedoelde? */
export function fontKlopt(font: { familie: string; bestand: string }, gekozen: string, postscript = ''): boolean {
  const kaal = (x: string) => (x.split('/').pop() ?? x).replace(/\.(ttf|otf)$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const bestand = kaal(font.bestand);
  const familie = kaal(font.familie);
  return [gekozen, postscript].filter(Boolean).some((n) => {
    const k = kaal(n);
    // Variabele fonts heten "Montserrat-Variable.ttf" maar melden zich als
    // "Montserrat-Regular": dan telt de familienaam aan het begin.
    return k === bestand || (familie.length > 0 && k.startsWith(familie) && existsSync(join(process.cwd(), 'assets', 'fonts', font.bestand)));
  });
}

/** Voor de log: welk font de ASS-stijl noemt (moet in assets/fonts staan). */
export function ondertitelFontBestand(stijl?: Huisstijl | null): string {
  return ondertitelFont(stijl).bestand;
}
