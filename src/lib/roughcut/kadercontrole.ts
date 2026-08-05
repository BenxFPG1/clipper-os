import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { focusNaarX, kaderKeten, type Kader } from './kader';
import type { Shot } from './index';

/**
 * Controleert of de spreker daadwerkelijk in de uitsnede past, en corrigeert
 * de kadrering tot het klopt.
 *
 * Waarom dit nodig is: tot nu toe wérd er wel gemeten waar iemand staat, maar
 * niet gecontroleerd wat daar uiteindelijk van in beeld kwam. Zoom, paneel en
 * focuspunt werden los van elkaar bepaald, en de combinatie kon een gezicht
 * half of helemaal buiten het kader duwen. Deze controle rekent de werkelijke
 * uitsnede uit en toetst hem tegen het gemeten gezichtsvak.
 *
 * Puur rekenwerk, geen AI-call: dat maakt hem gratis en herhaalbaar. De
 * visuele controle daarna vangt wat je niet kunt uitrekenen.
 */

/** De verhouding van het doelkader: 1080 op 1920. */
const DOEL_VERHOUDING = 1080 / 1920;

/** De verhouding van een normale bron; wordt smaller binnen een split-screen-paneel. */
const BRON_VERHOUDING = 16 / 9;

/** Marge rond het gezicht die binnen de uitsnede moet vallen. */
const MARGE = 0.35;

export type Uitsnede = { x0: number; x1: number; y0: number; y1: number };

/**
 * De uitsnede die de montage werkelijk maakt, als fractie van het bronbeeld
 * (of van het paneel, als er binnen een split screen gekadreerd wordt).
 */
export function uitsnedeVan(
  focusX: number,
  zoom: number,
  focusY = 0.5,
  /**
   * Breedte/hoogte van het beeld waaruit gesneden wordt. Binnen een paneel van
   * een split screen is dat een stuk smaller, en dan beslaat dezelfde uitsnede
   * een veel groter deel van de breedte — bij 16:9 een derde, bij een half
   * paneel al driekwart. Zonder die correctie oordeelt de controle dat een
   * hoofd niet past terwijl het ruim past, of andersom.
   */
  bronVerhouding = BRON_VERHOUDING,
): Uitsnede {
  const breedte = Math.min(1, DOEL_VERHOUDING / bronVerhouding / zoom);
  const hoogte = Math.min(1, 1 / zoom);

  const f = Math.min(1, Math.max(0, focusX));
  const x0 = Math.min(Math.max(f * (1 - breedte), 0), 1 - breedte);
  const y0 = Math.min(Math.max(focusY - hoogte / 2, 0), 1 - hoogte);

  return { x0, x1: x0 + breedte, y0, y1: y0 + hoogte };
}

export type Gezicht = { x: number; breedte: number; top: number; hoogte: number };

/** Zit het gezicht met marge binnen de uitsnede? */
export function gezichtPast(g: Gezicht, u: Uitsnede): boolean {
  const links = g.x - (g.breedte / 2) * (1 + MARGE);
  const rechts = g.x + (g.breedte / 2) * (1 + MARGE);
  const boven = g.top - g.hoogte * MARGE;
  const onder = g.top + g.hoogte * (1 + MARGE * 0.5);
  return links >= u.x0 && rechts <= u.x1 && boven >= u.y0 && onder <= u.y1;
}

export type Correctie = { volgorde: number; wat: string };

/**
 * Corrigeert de kadrering van shots waar de spreker niet (helemaal) in beeld
 * valt. In volgorde van ingrijpendheid: eerst het focuspunt verschuiven, dan
 * uitzoomen, en als laatste redmiddel het paneel loslaten — want zonder paneel
 * zie je de naad van het split screen, maar dat is nog altijd beter dan een
 * uitsnede zonder mens erin.
 */
export function corrigeerKadrering(
  shots: (Shot & { gezicht?: Gezicht })[],
): Correctie[] {
  const correcties: Correctie[] = [];

  for (const shot of shots) {
    const g = shot.gezicht;
    if (!g) continue;

    // Binnen een paneel is alles relatief aan dat paneel: een hoofd van 12% van
    // het hele beeld is 24% van een half paneel.
    const paneelBreed = shot.paneel ? shot.paneel[1] - shot.paneel[0] : 1;
    const inPaneel: Gezicht = {
      x: shot.paneel ? (g.x - shot.paneel[0]) / paneelBreed : g.x,
      breedte: g.breedte / paneelBreed,
      top: g.top,
      hoogte: g.hoogte,
    };

    let zoom = shot.zoom ?? 1;
    let focusX = shot.focusX !== undefined
      ? (shot.paneel ? (shot.focusX - shot.paneel[0]) / paneelBreed : shot.focusX)
      : 0.5;
    // Ooghoogte op ongeveer een derde van boven: dat is de klassieke plek voor
    // een sprekend hoofd en houdt de kin uit de onderste rand.
    let focusY = Math.min(0.85, Math.max(0.15, g.top + g.hoogte * 0.38 + 0.06));
    const gedaan: string[] = [];

    // Valt de spreker buiten het paneel dat we kozen? Dan klopte het paneel
    // niet — loslaten en gewoon verder rekenen op het hele beeld.
    if (shot.paneel && (inPaneel.x < 0 || inPaneel.x > 1)) {
      shot.paneel = undefined;
      gedaan.push('paneel losgelaten (spreker stond er niet in)');
      inPaneel.x = g.x;
      inPaneel.breedte = g.breedte;
      focusX = g.x;
    }

    const verhouding = BRON_VERHOUDING * (shot.paneel ? shot.paneel[1] - shot.paneel[0] : 1);

    for (let ronde = 0; ronde < 8; ronde++) {
      const u = uitsnedeVan(focusX, zoom, focusY, verhouding);
      if (gezichtPast(inPaneel, u)) break;

      const breedte = u.x1 - u.x0;
      const past = inPaneel.breedte * (1 + MARGE) <= breedte;

      if (past) {
        // Past wel, maar staat verkeerd: het focuspunt naar het gezicht toe.
        const nieuw = (inPaneel.x - breedte / 2) / Math.max(0.001, 1 - breedte);
        focusX = Math.min(1, Math.max(0, nieuw));
        if (!gedaan.includes('focus')) gedaan.push('focus');
      } else if (zoom > 1.02) {
        zoom = Math.max(1, zoom - 0.15);
        if (!gedaan.includes('minder zoom')) gedaan.push('minder zoom');
      } else {
        // Zonder zoom past het nog niet: het hoofd is simpelweg breder dan een
        // negen-zestiende uitsnede. Dan blijft alleen het midden nemen.
        focusX = Math.min(1, Math.max(0, inPaneel.x));
        gedaan.push('gezicht past niet in staand kader');
        break;
      }

      // Verticaal past het niet? Dan is uitzoomen het enige middel, want de
      // uitsnede is al zo hoog als het beeld.
      const nu = uitsnedeVan(focusX, zoom, focusY, verhouding);
      if (inPaneel.top < nu.y0 || inPaneel.top + inPaneel.hoogte > nu.y1) {
        if (zoom > 1.02) {
          zoom = Math.max(1, zoom - 0.15);
          if (!gedaan.includes('minder zoom')) gedaan.push('minder zoom');
        } else {
          focusY = Math.min(0.85, Math.max(0.15, inPaneel.top + inPaneel.hoogte / 2));
        }
      }
    }

    if (gedaan.length) {
      shot.zoom = zoom;
      shot.focusX = shot.paneel ? shot.paneel[0] + focusX * (shot.paneel[1] - shot.paneel[0]) : focusX;
      shot.focusY = focusY;
      correcties.push({ volgorde: shot.volgorde, wat: gedaan.join(' + ') });
    } else {
      // Ook zonder correctie de ooghoogte toepassen: de kin hoort niet tegen de
      // onderrand te staan.
      shot.focusY = focusY;
    }
  }

  return correcties;
}

/**
 * Rendert per shot één beeld door exact dezelfde kaderketen als de montage,
 * zodat de visuele controle beoordeelt wat de kijker straks ziet — en niet een
 * benadering daarvan.
 */
export async function maakControlebeelden(
  bronBestand: string,
  shots: Shot[],
  map: string,
  kader: Kader,
): Promise<{ volgorde: number; pad: string }[]> {
  const uit: { volgorde: number; pad: string }[] = [];

  for (const shot of shots) {
    const t = shot.start + (shot.end - shot.start) / 2;
    const paneelKnip = shot.paneel
      ? `crop=iw*${(shot.paneel[1] - shot.paneel[0]).toFixed(4)}:ih:iw*${shot.paneel[0].toFixed(4)}:0,`
      : '';
    const focusInPaneel =
      shot.paneel && typeof shot.focusX === 'number'
        ? (shot.focusX - shot.paneel[0]) / (shot.paneel[1] - shot.paneel[0])
        : shot.focusX;
    const keten = kaderKeten(kader, {
      focusX: focusNaarX(shot.focus, focusInPaneel),
      zoom: shot.zoom ?? 1,
      focusY: shot.focusY,
    });

    const pad = join(map, `check-${String(shot.volgorde).padStart(2, '0')}.jpg`);
    await new Promise<void>((klaar) => {
      const kind = spawn(resolveBinary('ffmpeg'), [
        '-nostdin', '-y',
        '-ss', t.toFixed(3),
        '-i', bronBestand,
        '-frames:v', '1',
        // Klein: voor een oordeel over kadrering is 360 breed genoeg, en het
        // scheelt fors in tokens.
        '-vf', `${paneelKnip}${keten},scale=360:-2`,
        '-q:v', '5',
        pad,
      ], { stdio: ['ignore', 'ignore', 'ignore'] });
      kind.on('error', () => klaar());
      kind.on('close', () => klaar());
    });

    if (existsSync(pad)) uit.push({ volgorde: shot.volgorde, pad });
  }

  return uit;
}

/**
 * Past de correctie toe die de visuele controle voorstelt. Bewust kleine
 * stappen: een controle die in één keer hard bijstuurt schiet door en levert
 * de volgende ronde het spiegelbeeldige probleem op.
 */
export function pasVisueleCorrectieToe(
  shot: Shot,
  correctie: string,
  sterkte: number,
): string | null {
  const stap = 0.06 + 0.14 * Math.min(1, Math.max(0, sterkte));

  switch (correctie) {
    case 'naar_links':
      shot.focusX = Math.max(0, (shot.focusX ?? 0.5) - stap);
      return `focus ${stap.toFixed(2)} naar links`;
    case 'naar_rechts':
      shot.focusX = Math.min(1, (shot.focusX ?? 0.5) + stap);
      return `focus ${stap.toFixed(2)} naar rechts`;
    case 'uitzoomen':
      if ((shot.zoom ?? 1) <= 1.001) {
        // Al helemaal uitgezoomd: dan zit het probleem in het paneel.
        if (shot.paneel) {
          shot.paneel = undefined;
          return 'paneel losgelaten';
        }
        return null;
      }
      shot.zoom = Math.max(1, (shot.zoom ?? 1) - stap * 1.5);
      return `zoom naar ${(shot.zoom ?? 1).toFixed(2)}`;
    case 'inzoomen':
      shot.zoom = Math.min(1.7, (shot.zoom ?? 1) + stap * 1.5);
      return `zoom naar ${(shot.zoom ?? 1).toFixed(2)}`;
    case 'hoger':
      shot.focusY = Math.max(0.15, (shot.focusY ?? 0.5) - stap);
      return `uitsnede omhoog`;
    case 'lager':
      shot.focusY = Math.min(0.85, (shot.focusY ?? 0.5) + stap);
      return `uitsnede omlaag`;
    default:
      return null;
  }
}
