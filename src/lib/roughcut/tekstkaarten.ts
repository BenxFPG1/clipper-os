import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
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
  accent?: string,
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
      await tekenKaart(tekst, bestand, accent);
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
async function tekenKaart(tekst: string, pad: string, accent?: string): Promise<void> {
  const B = 1080;
  const H = 1920;
  const canvas = createCanvas(B, H);
  const ctx = canvas.getContext('2d');

  const fontgrootte = tekst.length > 24 ? 54 : 68;
  ctx.font = `600 ${fontgrootte}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const breedte = ctx.measureText(tekst).width;

  const padding = 42;
  const balkB = Math.min(B - 80, breedte + padding * 2);
  const balkH = fontgrootte + 46;
  const x = (B - balkB) / 2;
  // Boven de onderste 20%: daar staan de caption en de knoppen van het platform.
  const y = H * 0.72;

  ctx.fillStyle = 'rgba(10, 10, 14, 0.82)';
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

  // Accentlijn in de huisstijlkleur van de campagne, zodat de kaarten bij het
  // merk horen in plaats van bij de tool.
  if (accent) {
    ctx.fillStyle = accent;
    ctx.fillRect(x, y + balkH - 6, balkB, 6);
  }

  ctx.fillStyle = '#FFFFFF';
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
export async function tekenHookKaart(tekst: string, pad: string, accent?: string): Promise<void> {
  const B = 1080;
  const H = 1920;
  const canvas = createCanvas(B, H);
  const ctx = canvas.getContext('2d');

  const fontgrootte = 72;
  ctx.font = `800 ${fontgrootte}px "Helvetica Neue", Helvetica, Arial, sans-serif`;

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

  ctx.fillStyle = 'rgba(10, 10, 14, 0.78)';
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

  if (accent) {
    ctx.fillStyle = accent;
    ctx.fillRect(x, y + blokH - 7, blokB, 7);
  }

  ctx.fillStyle = '#FFFFFF';
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
