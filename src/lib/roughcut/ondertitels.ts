import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { resolveBinary } from '../ingest/binaries';
import { instelling } from './instellingen';
import { FONTS, fontVoor, veiligeTekst, type Huisstijl } from './tekstkaarten';
import type { BurnOverlay, Shot } from './index';
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
 * Positie: onderin, maar boven de onderste 20% waar TikTok en Reels hun
 * caption en knoppen zetten, en onder de tijdsprongkaart (die op 72% staat).
 */

export type OndertitelWoord = { w: string; s: number; e: number };
export type OndertitelRegel = { s: number; e: number; woorden: OndertitelWoord[] };

/** Onderrand van de tekst als fractie van de hoogte; erboven staat niets van het platform. */
const ONDERRAND = 0.665;
const FONTGROOTTE = 66;

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
 * loopt alleen de kleur mee met de stem.
 */
export function bouwAss(regels: OndertitelRegel[], stijl?: Huisstijl | null): string {
  const font = fontVoor(stijl);
  const accent = assKleur(stijl?.accent, '&H0000D7FF&'); // geel als er geen huisstijl is
  const wit = '&H00FFFFFF&';
  // MarginV is de afstand van de onderrand tot de tekst (Alignment 2 = onder-midden).
  const margeV = Math.round(1920 * (1 - ONDERRAND));
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
    `Style: Woord,${font.familie},${FONTGROOTTE},${wit},${wit},&H00000000&,&H80000000&,-1,0,0,0,100,100,0,0,1,4,2,2,60,60,${margeV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const veilig = (t: string) => t.replace(/[{}\\]/g, '').replace(/\n/g, ' ');
  const dialogen: string[] = [];
  for (const regel of regels) {
    regel.woorden.forEach((woord, k) => {
      const van = woord.s;
      const tot = k + 1 < regel.woorden.length ? regel.woorden[k + 1].s : regel.e;
      if (tot - van < 0.01) return;
      const tekst = regel.woorden
        .map((x, i) => (i === k ? `{\\c${accent}}${veilig(x.w)}{\\c${wit}}` : veilig(x.w)))
        .join(' ');
      dialogen.push(`Dialogue: 0,${assTijd(van)},${assTijd(tot)},Woord,,0,0,0,,${tekst}`);
    });
  }
  return `${kop.join('\n')}\n${dialogen.join('\n')}\n`;
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

/** Terugval zonder libass: één PNG per regel, zelfde plek en font. */
async function tekenRegelPng(tekst: string, pad: string, stijl?: Huisstijl | null): Promise<void> {
  const font = fontVoor(stijl);
  const B = 1080;
  const H = 1920;
  const canvas = createCanvas(B, H);
  const ctx = canvas.getContext('2d');
  ctx.font = `${font.gewicht} ${FONTGROOTTE}px "${font.familie}", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const y = H * ONDERRAND;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(tekst, B / 2, y);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(tekst, B / 2, y);
  await writeFile(pad, canvas.toBuffer('image/png'));
}

export type Ondertitels = {
  regels: OndertitelRegel[];
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
): Promise<Ondertitels> {
  const regels = groepeerRegels(woordenOpTijdlijn(segmenten, bronWoorden));
  const srt = bouwSrtUitRegels(regels);
  if (regels.length === 0) return { regels, overlays: [], srt };

  if (heeftAssFilter()) {
    const assPad = join(map, `${voorvoegsel}-ondertitels.ass`);
    await writeFile(assPad, bouwAss(regels, stijl));
    return { regels, assPad, overlays: [], srt };
  }

  const overlays: BurnOverlay[] = [];
  for (const [i, regel] of regels.entries()) {
    const pad = join(map, `${voorvoegsel}-ot-${String(i).padStart(3, '0')}.png`);
    await tekenRegelPng(regel.woorden.map((w) => w.w).join(' '), pad, stijl);
    overlays.push({ pad, start: regel.s, end: regel.e });
  }
  return { regels, overlays, srt };
}

/** Voor de log: welk font de ASS-stijl noemt (moet in assets/fonts staan). */
export function ondertitelFontBestand(stijl?: Huisstijl | null): string {
  return (FONTS[stijl?.font ?? 'archivo'] ?? FONTS.archivo).bestand;
}
