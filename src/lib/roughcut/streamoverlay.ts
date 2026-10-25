import { spawnSync } from 'node:child_process';
import { instelling } from './instellingen';
import { gezichtPast, uitsnedeVan, type Uitsnede } from './kadercontrole';
import { basisZoom, type Shot } from './index';
import { deelstukken } from './scenes';
import type { Box } from './graphics';
import type { Kader } from './kader';
import type { KeuringRegel } from './keuring';

/**
 * Stream-overlays (chat, teller, watermerk) zo veel mogelijk uit het kader.
 *
 * Een IRL-stream (TOTA) draagt de hele video lang een chatvenster linksboven,
 * een teller rechtsboven en een watermerk onderin. gezichten.py vindt die
 * vakken (cellen met vaste tekst in een bewegend beeld) en telt de avatars in
 * de chat niet meer als gezicht. Hier schuift het kader er zo nodig vanaf:
 * eerst een klein stukje opzij (de spreker blijft binnen de middenmarge van
 * de keuring, anders draait het zelfherstel het weer terug), anders iets
 * inzoomen zodat de uitsnede onder of boven het vak valt, zolang de
 * resolutie dat toelaat. Lukt geen van beide, dan blijft het staan: een
 * stukje chat in beeld is beter dan een spreker die half wegvalt.
 */

const BRON_VERHOUDING = 16 / 9;

/** Meet de overlays van een bron via gezichten.py --overlays (gecachet naast het bestand). */
export function meetStreamOverlays(bronPad: string, py: { cmd: string; voor: string[] }): Box[] {
  const res = spawnSync(py.cmd, [...py.voor, 'scripts/gezichten.py', bronPad, '--overlays'], { encoding: 'utf8', maxBuffer: 1_000_000 });
  try {
    const regel = (res.stdout ?? '').split('\n').map((r) => r.trim()).reverse().find((r) => r.startsWith('['));
    const vakken = JSON.parse(regel || '[]') as Box[];
    return vakken.filter((v) => v.x1 > v.x0 && v.y1 > v.y0);
  } catch {
    return [];
  }
}

/** Overlapt de uitsnede het vak noemenswaardig (meer dan 1% van de uitsnede)? */
export function overlapt(u: Uitsnede, v: Box): boolean {
  const b = Math.max(0, Math.min(u.x1, v.x1) - Math.max(u.x0, v.x0));
  const h = Math.max(0, Math.min(u.y1, v.y1) - Math.max(u.y0, v.y0));
  return b * h > 0.01 * (u.x1 - u.x0) * (u.y1 - u.y0);
}

/** Hoogste zoom die bij deze bronhoogte nog binnen STREAM_MAX_OPSCHAAL blijft (geen plafond als de hoogte onbekend is). */
export function zoomPlafond(bronHoogte: number | null | undefined): number {
  const max = instelling('ZOOM_MAX');
  if (!bronHoogte) return max;
  return Math.max(1, Math.min(max, (instelling('PERSOON_MAX_OPSCHAAL') * bronHoogte) / 1920));
}

/** Een shot dat de overlay kan tonen: vullend kader met een gemeten gezicht, geen graphic-deelstuk. */
function telt(seg: Shot, kader: Kader): boolean {
  if (!seg.gezicht || seg.paneel) return false;
  return deelstukken(seg, kader).every((d) => d.kader === 'vullend' || d.kader === 'staand');
}

function uitsnede(seg: Shot, focusX = seg.focusX ?? 0.5, zoom = seg.zoom ?? basisZoom(seg), focusY = seg.focusY ?? 0.5): Uitsnede {
  return uitsnedeVan(focusX, zoom, focusY, BRON_VERHOUDING);
}

/** Staat het gezicht na de ingreep nog binnen de middenmarge van de keuring? */
function inMidden(seg: Shot, u: Uitsnede): boolean {
  const g = seg.gezicht!;
  const inBeeld = (g.x - u.x0) / (u.x1 - u.x0);
  return Math.abs(inBeeld - 0.5) <= instelling('STREAM_MIDDEN_MARGE') && gezichtPast(g, u);
}

/** Verschuift focusX (en een horizontaal spoor) met dx. */
function schuifX(seg: Shot, dx: number): void {
  seg.focusX = Math.round(Math.min(1, Math.max(0, (seg.focusX ?? 0.5) + dx)) * 1000) / 1000;
  if (seg.spoor?.length) seg.spoor = seg.spoor.map((p) => ({ ...p, x: Math.min(1, Math.max(0, p.x + dx)) }));
}

/**
 * Probeert per shot de overlays buiten de uitsnede te houden. Muteert focusX,
 * spoor, zoom en focusY; levert per ingreep een logregel en het aantal shots
 * waarin toch nog een overlay staat.
 */
export function wijkVoorOverlays(
  segmenten: Shot[],
  vakken: Box[],
  kader: Kader,
  opties: { bronHoogte?: number | null } = {},
): { regels: string[]; nogInBeeld: number[] } {
  const regels: string[] = [];
  const nogInBeeld: number[] = [];
  if (!vakken.length) return { regels, nogInBeeld };
  const plafond = zoomPlafond(opties.bronHoogte);
  for (const seg of segmenten) {
    if (!telt(seg, kader)) continue;
    const raak = () => vakken.filter((v) => overlapt(uitsnede(seg), v));
    if (raak().length === 0) continue;
    // (1) Opzij: de kleinste verschuiving die alle geraakte vakken vrijlaat
    // en de spreker in het midden houdt.
    const u0 = uitsnede(seg);
    const breedte = u0.x1 - u0.x0;
    const kandidaten = new Set<number>();
    for (const v of raak()) {
      kandidaten.add(v.x1 - u0.x0 + 0.002); // vak links: kader naar rechts
      kandidaten.add(v.x0 - u0.x1 - 0.002); // vak rechts: kader naar links
    }
    const opzij = [...kandidaten]
      .filter((dx) => Math.abs(dx) <= breedte * instelling('STREAM_MIDDEN_MARGE') + 1e-9)
      .sort((a, b) => Math.abs(a) - Math.abs(b))
      .find((dx) => {
        const u = uitsnede(seg, (seg.focusX ?? 0.5) + dx);
        return inMidden(seg, u) && !vakken.some((v) => overlapt(u, v));
      });
    if (opzij !== undefined) {
      schuifX(seg, opzij);
      regels.push(`shot ${seg.volgorde}: stream-overlay → kader ${opzij > 0 ? 'naar rechts' : 'naar links'} (${opzij.toFixed(3)})`);
      continue;
    }
    // (2) Iets inzoomen, met de uitsnede onder een vak bovenin of boven een
    // vak onderin, binnen het zoomplafond van de bron.
    const g = seg.gezicht!;
    const nu = seg.zoom ?? basisZoom(seg);
    let gelukt = false;
    for (let z = nu; z <= plafond + 1e-9 && !gelukt; z += 0.02) {
      const h = 1 / z;
      // Kandidaat-boven-randen: net onder elk vak bovenin, of zo dat de
      // onderrand net boven elk vak onderin valt.
      const y0s = [
        ...vakken.filter((v) => v.y0 <= 0.02).map((v) => v.y1 + 0.005),
        ...vakken.filter((v) => v.y1 >= 0.98).map((v) => v.y0 - 0.005 - h),
      ];
      for (const y0 of y0s) {
        if (y0 < 0 || y0 + h > 1) continue;
        const fy = y0 + h / 2;
        const u = uitsnede(seg, seg.focusX ?? 0.5, z, fy);
        if (!inMidden(seg, u) || g.top - g.hoogte * 0.15 < u.y0 || vakken.some((v) => overlapt(u, v))) continue;
        seg.zoom = Math.round(z * 1000) / 1000;
        seg.focusY = Math.round(fy * 1000) / 1000;
        seg.spoorY = undefined;
        regels.push(`shot ${seg.volgorde}: stream-overlay → ingezoomd tot ${seg.zoom.toFixed(2)} buiten het vak`);
        gelukt = true;
        break;
      }
    }
    if (!gelukt) nogInBeeld.push(seg.volgorde);
  }
  return { regels, nogInBeeld };
}

/**
 * Begrenst de zoom van persoonshots op een lage-resolutiebron (Drive,
 * WeTransfer: vaak 1080p). Een 9:16-uitsnede uit 1080p is bij zoom 1 al
 * ×1,78 opgeschaald; het zelfherstel zette TOTA op zoom 1,70 (×3) en dat
 * werd wazig. Graphic-deelstukken hebben hun eigen grens (GRAPHIC_MAX_OPSCHAAL).
 */
export function begrensOpschaal(segmenten: Shot[], kader: Kader, bronHoogte: number | null | undefined): string[] {
  const plafond = zoomPlafond(bronHoogte);
  const regels: string[] = [];
  for (const seg of segmenten) {
    if (!seg.gezicht || !telt(seg, kader)) continue;
    const z = seg.zoom ?? basisZoom(seg);
    if (z > plafond + 1e-6) {
      seg.zoom = Math.round(plafond * 1000) / 1000;
      regels.push(`shot ${seg.volgorde}: zoom ${z.toFixed(2)} → ${seg.zoom.toFixed(2)} (bron ${bronHoogte}p)`);
    }
  }
  return regels;
}

/** Keuringsregel (informatief): in hoeveel shots nog een stream-overlay staat. Faalt niet: een stukje chat is geen fout, wel iets om te zien. */
export function keurStreamOverlay(vakken: Box[] | null | undefined, nogInBeeld: number[]): KeuringRegel {
  const naam = 'stream-overlay uit beeld';
  if (!vakken?.length) return { naam, goed: null, detail: 'geen stream-overlay in de bron' };
  return {
    naam,
    goed: null,
    detail: nogInBeeld.length
      ? `${vakken.length} vak(ken); nog in beeld in shot ${nogInBeeld.join(', ')} (opzij of inzoomen paste niet zonder de spreker uit het midden te halen)`
      : `${vakken.length} vak(ken), overal buiten het kader`,
  };
}
