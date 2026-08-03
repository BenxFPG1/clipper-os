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
      await tekenKaart(tekst, bestand);
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
async function tekenKaart(tekst: string, pad: string): Promise<void> {
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

  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(tekst, B / 2, y + balkH / 2 + 2);

  await writeFile(pad, canvas.toBuffer('image/png'));
}

/** Zorgt dat de map voor de kaarten bestaat. */
export async function kaartenMap(basis: string): Promise<string> {
  const map = join(basis, 'kaarten');
  await mkdir(map, { recursive: true });
  return map;
}
