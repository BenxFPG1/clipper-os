import type { Shot } from './index';
import type { GraphicFout } from './keuring';
import type { BronWoord } from './woorden';
import { verzetGrens } from './poort';
import { schaalTovPassend, unie } from './graphics';

/**
 * Zelfherstel: de keuring als poort in plaats van als rapport achteraf.
 *
 * De detectie (gezichten, inhoudsbox, eindscherm) kan zich vergissen — een
 * graphic die inanimeert, een wijd shot zonder gevonden gezicht, een overlay
 * die later opkomt. De keuring meet daarna opnieuw, los van de beslissing, en
 * ziet dat. Hier wordt elke fout vertaald naar de veilige terugval:
 *
 * - inhoud buiten beeld na inzoomen → niet inzoomen, gewoon passend;
 * - graphic vullend gekadreerd      → passend (geen gezicht, wél een graphic);
 * - camerabeeld in passend kader     → vullend op de persoon;
 * - eindscherm in beeld              → het shot inkorten tot vóór de overlay.
 *
 * De worker rendert daarna opnieuw en keurt opnieuw, hoogstens
 * ZELFHERSTEL_RONDES keer; wat dan nog faalt is review_nodig.
 */

const overlapt = (a: { van: number; tot: number }, van: number, tot: number) => a.van < tot - 0.05 && a.tot > van + 0.05;

/** Voert de herstelacties uit op de segmenten (muteert) en levert per actie één regel. */
export function herstelNaKeuring(
  segmenten: Shot[],
  graphicFouten: GraphicFout[],
  overlayFouten: { volgorde: number }[],
  opties: { bronWoorden?: BronWoord[] | null } = {},
): string[] {
  const acties: string[] = [];
  for (const f of graphicFouten) {
    const seg = segmenten.find((s) => s.volgorde === f.volgorde);
    if (!seg) continue;
    const scenes = (seg.scenes ?? []).filter((sc) => overlapt(sc, f.van, f.tot));
    if (f.soort === 'inhoud_buiten_beeld') {
      // Adaptief: eerst opnieuw kaderen met de ná de render gemeten inhoud
      // (unie met de oude box — de graphic bleek breder, meestal door
      // animatie). Pas als dát ook faalt, de inzoom eraf.
      for (const sc of scenes) {
        if (!sc.inhoud) continue;
        if (f.gemeten && sc.inhoudBron !== 'verbreed') {
          const breder = unie([sc.inhoud, f.gemeten]);
          if (breder && (breder.x1 - breder.x0) * (breder.y1 - breder.y0) <= 0.92) {
            sc.inhoud = breder;
            sc.inhoudBron = 'verbreed';
            acties.push(`shot ${f.volgorde} ${f.van.toFixed(1)}s: inhoud breder gemeten → opnieuw gekadreerd (×${schaalTovPassend(breder).toFixed(2).replace('.', ',')} t.o.v. passend)`);
            continue;
          }
        }
        sc.inhoud = null;
        acties.push(`shot ${f.volgorde} ${f.van.toFixed(1)}s: inzoom eraf → passend`);
      }
    } else if (f.soort === 'graphic_vullend') {
      if (scenes.length) {
        for (const sc of scenes) {
          sc.gezicht = false;
          sc.wijd = false;
          sc.inhoud = null;
        }
      } else {
        // Geen scènes: het deelstuk ís het shot, of een stuk ervan.
        const delen = [
          ...(f.van > seg.start + 0.3 ? [{ van: seg.start, tot: f.van, gezicht: null }] : []),
          { van: Math.max(seg.start, f.van), tot: Math.min(seg.end, f.tot), gezicht: false as const, inhoud: null },
          ...(f.tot < seg.end - 0.3 ? [{ van: f.tot, tot: seg.end, gezicht: null }] : []),
        ];
        seg.scenes = delen;
      }
      acties.push(`shot ${f.volgorde} ${f.van.toFixed(1)}s: graphic → passend`);
    } else if (f.soort === 'camerabeeld_passend') {
      if (scenes.length) {
        for (const sc of scenes) {
          sc.gezicht = true;
          sc.wijd = true;
          sc.inhoud = null;
        }
      }
      if (seg.beeldtype === 'graphic') seg.beeldtype = 'persoon';
      acties.push(`shot ${f.volgorde} ${f.van.toFixed(1)}s: camerabeeld → vullend op de persoon`);
    }
  }
  for (const f of overlayFouten) {
    const seg = segmenten.find((s) => s.volgorde === f.volgorde);
    if (!seg || seg.overlayVanaf === undefined) continue;
    const grens = seg.overlayVanaf - 0.5;
    const woord = (opties.bronWoorden ?? []).filter((w) => w.e <= grens && w.e > seg.start + 1).pop();
    const eind = woord ? woord.e + 0.1 : grens;
    if (eind - seg.start >= 1.2 && eind < seg.end) {
      verzetGrens(seg, { end: eind });
      seg.overlay = undefined;
      acties.push(`shot ${f.volgorde}: eindscherm → ingekort tot ${eind.toFixed(2)} s`);
    }
  }
  return acties;
}

export type HerstelKeuring = () => Promise<{ graphic: GraphicFout[]; overlay: { volgorde: number; wat: string }[] }>;

/**
 * Eén zelfherstelstap: keuren, en bij fouten herstellen. Levert of er
 * opnieuw gerenderd moet worden en een logregel. De worker roept dit na elke
 * render aan (binnen zijn poging-lus), tot er niets meer faalt of de rondes
 * op zijn; zo is de lus met een gestubde keuring te toetsen.
 */
export async function zelfherstelStap(
  segmenten: Shot[],
  keur: HerstelKeuring,
  opties: { ronde: number; maxRondes: number; bronWoorden?: BronWoord[] | null },
): Promise<{ opnieuw: boolean; ronde: number; log: string | null }> {
  if (opties.ronde >= opties.maxRondes) return { opnieuw: false, ronde: opties.ronde, log: null };
  const { graphic, overlay } = await keur();
  if (graphic.length === 0 && overlay.length === 0) {
    return { opnieuw: false, ronde: opties.ronde, log: opties.ronde > 0 ? `zelfherstel: na ronde ${opties.ronde} graphics en eindscherm in orde` : null };
  }
  const ronde = opties.ronde + 1;
  const acties = herstelNaKeuring(segmenten, graphic, overlay, { bronWoorden: opties.bronWoorden });
  return {
    opnieuw: acties.length > 0,
    ronde,
    log:
      `zelfherstel ronde ${ronde}: ${[...graphic.map((f) => f.wat), ...overlay.map((f) => f.wat)].join('; ')}` +
      ` → ${acties.length ? acties.join('; ') : 'geen herstel mogelijk'}`,
  };
}
