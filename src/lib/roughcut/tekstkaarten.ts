import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

export type Huisstijl = { accent?: string | null; font?: string | null };

/**
 * Merk-fonts (OFL-licentie, meegeleverd in assets/fonts). Eén keer registreren;
 * daarna kiest de huisstijl van de campagne welke gebruikt wordt.
 */
export const FONTS: Record<string, { bestand: string; familie: string; gewicht: string; karakter: string }> = {
  archivo: {
    bestand: 'ArchivoBlack-Regular.ttf',
    familie: 'Archivo Black',
    gewicht: '400',
    karakter: 'Vet en breed, schreefloos. Neutraal-krachtig; past bij nieuws, zaken en alles wat gewicht moet hebben.',
  },
  anton: {
    bestand: 'Anton-Regular.ttf',
    familie: 'Anton',
    gewicht: '400',
    karakter: 'Extreem vet en smal. Schreeuwerig in de goede zin; past bij entertainment, sport en harde hooks.',
  },
  bebas: {
    bestand: 'BebasNeue-Regular.ttf',
    familie: 'Bebas Neue',
    gewicht: '400',
    karakter: 'Smal, hoog, alleen kapitalen. Modern en sportief; past bij lifestyle, fitness en jonge merken.',
  },
  oswald: {
    bestand: 'Oswald-Variable.ttf',
    familie: 'Oswald',
    gewicht: '600',
    karakter: 'Smal en zakelijk, iets klassieker dan Bebas. Past bij journalistiek, documentaire en analyse.',
  },
  montserrat: {
    bestand: 'Montserrat-Variable.ttf',
    familie: 'Montserrat',
    gewicht: '800',
    karakter: 'Rond en vriendelijk geometrisch. Past bij consumentenmerken, food, reizen en alles luchtigs.',
  },
  inter: {
    bestand: 'Inter-Variable.ttf',
    familie: 'Inter',
    gewicht: '800',
    karakter: 'Neutraal en schermgericht. Past bij tech, software en fintech.',
  },
  space_grotesk: {
    bestand: 'SpaceGrotesk-Variable.ttf',
    familie: 'Space Grotesk',
    gewicht: '700',
    karakter: 'Eigenzinnig schreefloos met technische inslag. Past bij startups, crypto en design.',
  },
  playfair: {
    bestand: 'PlayfairDisplay-Variable.ttf',
    familie: 'Playfair Display',
    gewicht: '700',
    karakter: 'Schreef met sterk contrast. Past bij luxe, mode, interieur en cultuur.',
  },
  dm_serif: {
    bestand: 'DMSerifDisplay-Regular.ttf',
    familie: 'DM Serif Display',
    gewicht: '400',
    karakter: 'Warme, redactionele schreef. Past bij media, opinie en persoonlijke verhalen.',
  },
};

let fontsGeladen = false;
function laadFonts(): void {
  if (fontsGeladen) return;
  fontsGeladen = true;
  for (const f of Object.values(FONTS)) {
    const pad = join(process.cwd(), 'assets', 'fonts', f.bestand);
    if (existsSync(pad)) GlobalFonts.registerFromPath(pad, f.familie);
  }
}

function fontVoor(stijl?: Huisstijl | null): { familie: string; gewicht: string } {
  laadFonts();
  const keuze = FONTS[stijl?.font ?? 'archivo'] ?? FONTS.archivo;
  return { familie: keuze.familie, gewicht: keuze.gewicht };
}
import type { Overlay } from './fcpxml';
import type { PlanShot } from './project-opbouw';

/**
 * Maakt de tekstkaarten die het plan voorschrijft als transparante PNG's, en
 * plaatst ze als beeldlaag boven de montage.
 *
 * Waarom PNG en niet een titel in het projectbestand: Premiere heeft zijn
 * oude titelformaat uit de XML-import gehaald, dus een gegenereerde titel komt
 * er niet of verminkt in. Een PNG met alfakanaal importeert altijd goed. De
 * kaart staat daarmee op de juiste plek en in de juiste lengte; restylen naar
 * je eigen huisstijl doe je in Premiere met je eigen tekstlaag erover.
 */
export async function maakTekstkaarten(
  shots: PlanShot[],
  map: string,
  voorvoegsel: string,
  stijl?: Huisstijl | null,
): Promise<Overlay[]> {
  const gesorteerd = [...shots].sort((a, b) => a.volgorde - b.volgorde);
  const overlays: Overlay[] = [];
  let cursor = 0;
  let teller = 0;

  for (const shot of gesorteerd) {
    const duur = Math.max(0, shot.end - shot.start);
    const tekst = kaartTekst(shot);

    if (tekst) {
      teller += 1;
      const bestand = join(map, `${voorvoegsel}-${String(teller).padStart(2, '0')}.png`);
      await tekenKaart(tekst, bestand, stijl);
      overlays.push({
        start: cursor,
        // Kaarten horen kort in beeld: lang genoeg om te lezen, kort genoeg om
        // niet in de weg te zitten.
        end: cursor + Math.min(2.2, Math.max(1.2, duur)),
        pad: bestand,
        naam: tekst.slice(0, 40),
      });
    }
    cursor += duur;
  }

  return overlays;
}

/**
 * Welke tekst hoort op de kaart? Nieuwe plannen zeggen het expliciet via
 * beeld_effect; oudere plannen noemen de tijdsprong alleen in de edit-notitie,
 * dus daar vissen we de aangehaalde regel uit.
 */
function kaartTekst(shot: PlanShot): string | null {
  const notitie = shot.edit_notitie ?? '';
  const aangehaald = notitie.match(/["'“„]([^"'”“]{3,40})["'”]/);

  if (shot.beeld_effect === 'tekstkaart') {
    return aangehaald?.[1] ?? standaardRegel(notitie);
  }
  // Terugval voor plannen van vóór de effectenvault.
  if (/tijdsprong|tekstkaart/i.test(notitie)) {
    return aangehaald?.[1] ?? standaardRegel(notitie);
  }
  return null;
}

function standaardRegel(notitie: string): string {
  if (/terug|eerder/i.test(notitie)) return 'eerder';
  if (/later|vooruit/i.test(notitie)) return 'later';
  return 'tijdsprong';
}

/**
 * Tekent één kaart: witte tekst op een afgeronde donkere balk, onderin beeld
 * maar boven de zone waar TikTok en Reels hun eigen knoppen zetten.
 *
 * Met een tekenbibliotheek in plaats van ffmpeg: de ffmpeg-bouw op deze machine
 * heeft geen tekstfilter, en een tekenbibliotheek met kant-en-klare binaries
 * werkt zowel hier als op de cloudrunner.
 */

/**
 * Welke tekstkleur leest op deze achtergrond? Puur rekenwerk (relatieve
 * luminantie), zodat een gele huisstijl zwarte letters krijgt en een donkerblauwe
 * witte — in plaats van overal wit, wat op licht accent onleesbaar is.
 */
function tekstOp(kleur: string): string {
  const hex = kleur.replace('#', '');
  const n = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.42 ? '#0A0A0E' : '#FFFFFF';
}

/**
 * De kleuren van één kaart. Het accent van de campagne is hier de dráger van de
 * kaart, niet een streepje eronder: met een donkere doos plus een dun lijntje
 * zien de kaarten van twee verschillende merken er praktisch identiek uit, en
 * dat was precies de klacht.
 */
function kaartkleuren(stijl?: Huisstijl | null): { vlak: string; tekst: string; rand: string | null } {
  const accent = stijl?.accent;
  if (!accent) return { vlak: 'rgba(10, 10, 14, 0.82)', tekst: '#FFFFFF', rand: null };
  return { vlak: accent, tekst: tekstOp(accent), rand: tekstOp(accent) === '#FFFFFF' ? null : 'rgba(0,0,0,0.25)' };
}

async function tekenKaart(tekst: string, pad: string, stijl?: Huisstijl | null): Promise<void> {
  const accent = stijl?.accent ?? undefined;
  const font = fontVoor(stijl);
  const B = 1080;
  const H = 1920;
  const canvas = createCanvas(B, H);
  const ctx = canvas.getContext('2d');

  const fontgrootte = tekst.length > 24 ? 54 : 68;
  ctx.font = `${font.gewicht} ${fontgrootte}px "${font.familie}", "Helvetica Neue", Arial, sans-serif`;
  const breedte = ctx.measureText(tekst).width;

  const padding = 42;
  const balkB = Math.min(B - 80, breedte + padding * 2);
  const balkH = fontgrootte + 46;
  const x = (B - balkB) / 2;
  // Boven de onderste 20%: daar staan de caption en de knoppen van het platform.
  const y = H * 0.72;

  const kleuren = kaartkleuren(stijl);
  ctx.fillStyle = kleuren.vlak;
  const r = 22;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + balkB - r, y);
  ctx.quadraticCurveTo(x + balkB, y, x + balkB, y + r);
  ctx.lineTo(x + balkB, y + balkH - r);
  ctx.quadraticCurveTo(x + balkB, y + balkH, x + balkB - r, y + balkH);
  ctx.lineTo(x + r, y + balkH);
  ctx.quadraticCurveTo(x, y + balkH, x, y + balkH - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = kleuren.tekst;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(tekst, B / 2, y + balkH / 2 + 2);

  await writeFile(pad, canvas.toBuffer('image/png'));
}

/**
 * De hook-overlay: de tekst die de eerste seconden in beeld staat. Groter en
 * hoger dan een tijdkaart, want dit ís de belofte van de clip. Meerdere regels
 * worden zelf afgebroken.
 */
export async function tekenHookKaart(tekst: string, pad: string, stijl?: Huisstijl | null): Promise<void> {
  const accent = stijl?.accent ?? undefined;
  const font = fontVoor(stijl);
  const B = 1080;
  const H = 1920;
  const canvas = createCanvas(B, H);
  const ctx = canvas.getContext('2d');

  const fontgrootte = 72;
  ctx.font = `${font.gewicht} ${fontgrootte}px "${font.familie}", "Helvetica Neue", Arial, sans-serif`;

  // Woorden over regels verdelen (max ~2 regels op deze grootte).
  const woorden = tekst.split(/\s+/);
  const regels: string[] = [];
  let huidig = '';
  for (const w of woorden) {
    const proef = `${huidig} ${w}`.trim();
    if (ctx.measureText(proef).width > B - 160 && huidig) {
      regels.push(huidig);
      huidig = w;
    } else huidig = proef;
  }
  if (huidig) regels.push(huidig);

  const regelH = fontgrootte + 22;
  const blokH = regels.length * regelH + 56;
  const y = H * 0.14;

  const kleuren = kaartkleuren(stijl);
  ctx.fillStyle = kleuren.vlak;
  const breedste = Math.max(...regels.map((r) => ctx.measureText(r).width));
  const blokB = Math.min(B - 80, breedste + 96);
  const x = (B - blokB) / 2;
  const r = 26;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + blokB - r, y);
  ctx.quadraticCurveTo(x + blokB, y, x + blokB, y + r);
  ctx.lineTo(x + blokB, y + blokH - r);
  ctx.quadraticCurveTo(x + blokB, y + blokH, x + blokB - r, y + blokH);
  ctx.lineTo(x + r, y + blokH);
  ctx.quadraticCurveTo(x, y + blokH, x, y + blokH - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = kleuren.tekst;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  regels.forEach((regel, i) => {
    ctx.fillText(regel, B / 2, y + 28 + regelH * i + regelH / 2);
  });

  await writeFile(pad, canvas.toBuffer('image/png'));
}

/**
 * Huisstijl v1: de dominante verzadigde kleur uit de thumbnail van de bron.
 * Geen AI-call — de thumbnail is hoe het merk zichzelf laat zien, en de
 * accentkleur maakt kaarten en hook herkenbaar als één account.
 */
export async function kleurUitThumbnail(youtubeUrl: string): Promise<string | null> {
  const id =
    youtubeUrl.match(/[?&]v=([\w-]{6,})/)?.[1] ?? youtubeUrl.match(/youtu\.be\/([\w-]{6,})/)?.[1];
  if (!id) return null;

  try {
    const res = await fetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    if (!res.ok) return null;
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(Buffer.from(await res.arrayBuffer()));
    const c = createCanvas(64, 48);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 64, 48);
    const data = ctx.getImageData(0, 0, 64, 48).data;

    let beste: [number, number, number] | null = null;
    let besteScore = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // Verzadiging x helderheid: we zoeken de kleur die eruit springt, niet
      // het zwart van een studio of het wit van een overlay.
      const score = (max - min) * (max > 40 && max < 240 ? 1 : 0.2);
      if (score > besteScore) {
        besteScore = score;
        beste = [r, g, b];
      }
    }
    if (!beste || besteScore < 40) return null;
    return `#${beste.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

/** Zorgt dat de map voor de kaarten bestaat. */
export async function kaartenMap(basis: string): Promise<string> {
  const map = join(basis, 'kaarten');
  await mkdir(map, { recursive: true });
  return map;
}
