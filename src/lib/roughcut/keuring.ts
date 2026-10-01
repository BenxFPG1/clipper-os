import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { controleerEindmontage } from './knipcontrole';
import { controleerScript, kopInBron } from './scriptcontrole';
import { TEASE_MAX_DUUR, woordOnder } from './poort';
import { uitsnedeVan } from './kadercontrole';
import { basisZoom } from './index';
import { instelling } from './instellingen';
import type { Shot } from './index';
import { deelstukken, gezichtMeterVia, type GezichtMeter } from './scenes';
import { boxBinnen, graphicMeterVia, inhoudKader, lijktGraphic, type Box, type GraphicMeter } from './graphics';
import type { Kader } from './kader';
import { keurLeesbaar } from './leestijd';
import { keurOverlay } from './eindscherm';
import { keurScherpBegin, scherpteMeterVia } from './scherpbegin';
import { keurOndertitelOverlap, keurOndertitelPlek, type OndertitelRegel, type Plek } from './ondertitels';

/** Breedte/hoogte van een normale bron. */
const BRON_VERHOUDING = 16 / 9;
import type { BronWoord } from './woorden';

/**
 * De keuring: meet een gerenderde clip tegen de eisen zoals ze gesteld zijn,
 * niet tegen wat toevallig makkelijk te meten valt.
 *
 * Dat onderscheid is de reden dat deze module bestaat. Eerdere controles
 * maten proxies — "komt de kop van het fragment ergens voor", "past het
 * gezichtsvak op het middenmoment" — en meldden groen terwijl er in het
 * eindbestand een half woord klonk of iemand half uit beeld stond. Een
 * verificatie die iets anders meet dan wat je beoordeelt, is erger dan geen
 * verificatie: hij geeft vertrouwen dat er niet is.
 *
 * Daarom hier vier metingen die één op één staan voor de klachten die telkens
 * terugkwamen:
 *
 *  - knippen: valt een grens binnen een woord? (exact, uit de woordtijden)
 *  - gezicht: staat de spreker in élk bemonsterd frame van het eindbestand
 *    volledig en groot genoeg in beeld? (gemeten op de gerenderde beelden)
 *  - script: klinkt elk fragment, en klinkt niets dubbel?
 *  - naden: is elke overgang stil?
 *
 * De uitkomst is een rapport met harde uitslagen, bruikbaar als poortwachter
 * in de evaluatieset én als eindcontrole bij een gewone render.
 */

export type KeuringRegel = {
  naam: string;
  /**
   * true = getoetst en goed, false = getoetst en fout, null = niet te toetsen
   * (geen brontranscriptie, python zonder OpenCV, whisper faalde). Dat laatste
   * was eerst ook `true` — en op een runner zonder werkende python stond het
   * hele rapport dan groen zonder één echte meting. Een keuring die niet kon
   * meten is geen goedkeuring.
   */
  goed: boolean | null;
  detail: string;
};

export type KeuringStatus = 'goed' | 'review_nodig' | 'niet_getoetst';

export type Keuringsrapport = {
  /** Alleen true als élke regel echt getoetst én goed is. */
  goed: boolean;
  /** Wat de worker en het dashboard tonen: goed, review nodig, of niets gemeten. */
  status: KeuringStatus;
  regels: KeuringRegel[];
};

/** De status uit de regels: één echte fout is "review nodig", geen enkele meting is "niet getoetst". */
export function keuringStatus(regels: KeuringRegel[]): KeuringStatus {
  if (regels.some((r) => r.goed === false)) return 'review_nodig';
  if (regels.every((r) => r.goed === null)) return 'niet_getoetst';
  return 'goed';
}

/** Regel 1: geen enkele knip mag binnen een woord vallen. */
export function keurKnippen(segmenten: Shot[], bronWoorden: BronWoord[] | null): KeuringRegel {
  if (!bronWoorden || bronWoorden.length === 0) {
    return { naam: 'knippen op woordgrenzen', goed: null, detail: 'geen brontranscriptie; niet te toetsen' };
  }

  const fouten: string[] = [];
  // In renderorde; een doorlopende naad (vorige eindigt exact waar deze
  // begint: camerawissel of kaderwissel) is geen knip in het geluid.
  const volg = [...segmenten].sort((a, b) => a.volgorde - b.volgorde);
  let doorlopend = 0;
  for (const [i, seg] of volg.entries()) {
    const naadVoor = i > 0 && Math.abs(volg[i - 1].end - seg.start) < 0.005;
    const naadNa = i + 1 < volg.length && Math.abs(volg[i + 1].start - seg.end) < 0.005;
    if (naadNa) doorlopend++;
    const s = naadVoor ? null : woordOnder(bronWoorden, seg.start);
    if (s) fouten.push(`shot ${seg.volgorde} start in "${s.w}"`);
    const e = naadNa ? null : woordOnder(bronWoorden, seg.end);
    if (e) fouten.push(`shot ${seg.volgorde} eind in "${e.w}"`);
  }
  const grof = bronWoorden.some((w) => (w as { grof?: boolean }).grof);

  return {
    naam: 'knippen op woordgrenzen',
    goed: fouten.length === 0,
    detail:
      (fouten.length === 0 ? `${segmenten.length * 2} grenzen, geen enkele in een woord` : fouten.join('; ')) +
      (doorlopend ? ` (${doorlopend} doorlopende naad/naden niet getoetst: geluid loopt door)` : '') +
      (grof ? ' — let op: deels grove woordtijden, toets minder precies' : ''),
  };
}

/** Regel 1b: geen shot bevat maar een deel van zijn scriptfragment. */
export function keurFragmenten(segmenten: Shot[]): KeuringRegel {
  const fouten: string[] = [];
  for (const seg of segmenten) {
    if (seg.ankerEind !== undefined && seg.end < seg.ankerEind - 0.15) {
      fouten.push(`shot ${seg.volgorde} mist ${(seg.ankerEind - seg.end).toFixed(1)}s aan het eind`);
    }
    if (seg.ankerStart !== undefined && seg.start > seg.ankerStart + 0.15) {
      fouten.push(`shot ${seg.volgorde} mist ${(seg.start - seg.ankerStart).toFixed(1)}s aan het begin`);
    }
  }
  return {
    naam: 'hele zinnen',
    goed: fouten.length === 0,
    detail: fouten.length === 0 ? 'elk shot bevat zijn volledige scriptfragment' : fouten.join('; '),
  };
}

/** Regel 2: geen twee segmenten delen bronmateriaal. */
export function keurOverlap(segmenten: Shot[]): KeuringRegel {
  const fouten: string[] = [];
  for (let i = 0; i < segmenten.length; i++) {
    for (let j = i + 1; j < segmenten.length; j++) {
      const overlap =
        Math.min(segmenten[i].end, segmenten[j].end) - Math.max(segmenten[i].start, segmenten[j].start);
      if (overlap > 0.15) {
        // Dezelfde uitzondering als de poort: een korte cold open deelt
        // bewust materiaal met de payoff.
        const tease = (segmenten[i].tease || segmenten[j].tease) &&
          Math.min(segmenten[i].end - segmenten[i].start, segmenten[j].end - segmenten[j].start) <= TEASE_MAX_DUUR;
        if (tease) continue;
        fouten.push(`shot ${segmenten[i].volgorde} en ${segmenten[j].volgorde} delen ${overlap.toFixed(1)}s`);
      }
    }
  }
  return {
    naam: 'geen gedeeld bronmateriaal',
    goed: fouten.length === 0,
    detail: fouten.length === 0 ? 'alle segmenten uniek' : fouten.join('; '),
  };
}

type GezichtMeting = { x: number; breedte: number; top: number; hoogte: number } | null;

/**
 * Regel 3: staat de spreker in élk bemonsterd moment gecentreerd en volledig
 * in beeld?
 *
 * Meetkundig, niet met een tweede gezichtsdetectie op het eindbestand. Dat
 * laatste is geprobeerd en bleek onbruikbaar: YuNet op een staand 9:16-beeld
 * gaf op hetzelfde moment 0,20 of 0,67 al naar gelang het aantal frames, en
 * een keuring die zichzelf tegenspreekt is geen keuring. Het gaat hier
 * bovendien om exacte grootheden — we weten waar het gezicht in de bron staat
 * (betrouwbaar gemeten op een liggend beeld) en we weten precies welke
 * uitsnede de montage neemt. Waar het gezicht in het eindbeeld terechtkomt is
 * dan rekenwerk, geen schatting.
 */
export type GezichtVak = { x: number; breedte: number; top: number; hoogte: number };
export type GezichtPuntMeting = (GezichtVak & { gezichten?: GezichtVak[] }) | null;
/** Meet per brontijd het gezicht (de spreker volgens de mondbeweging) en alle gezichten. */
export type SprekerPuntMeter = (tijden: number[]) => Promise<GezichtPuntMeting[] | null>;

/** Een moment waarop de actieve spreker niet goed in beeld staat, met het gezicht waar het kader heen moet. */
export type SprekerFout = {
  volgorde: number;
  t: number;
  soort: 'buiten' | 'uit_midden' | 'niet_in_beeld';
  /** Aandeel van het hoofd buiten beeld, of afwijking van het midden (0..1+). */
  waarde: number;
  gezicht: GezichtVak;
};

const puntCache = new Map<string, GezichtPuntMeting>();

/** De standaardmeter: gezichten.py (3 frames per punt), gecachet per bron en tijd — de meting hangt niet van het kader af. */
export function sprekerPuntMeterVia(bronPad: string, py: { cmd: string; voor: string[] }): SprekerPuntMeter {
  return async (tijden) => {
    const sleutel = (t: number) => `${bronPad}|${t.toFixed(2)}`;
    const nodig = [...new Set(tijden.filter((t) => !puntCache.has(sleutel(t))))];
    if (nodig.length) {
      const res = spawnSync(py.cmd, [...py.voor, 'scripts/gezichten.py', bronPad, JSON.stringify(nodig), '3'], { encoding: 'utf8', maxBuffer: 20_000_000 });
      try {
        // OpenCV schrijft soms zelf naar stdout; pak de laatste regel die JSON is.
        const regel = (res.stdout ?? '').split('\n').map((r) => r.trim()).reverse().find((r) => r.startsWith('['));
        const m = JSON.parse(regel || '[]') as GezichtPuntMeting[];
        if (m.length !== nodig.length) return null;
        nodig.forEach((t, i) => puntCache.set(sleutel(t), m[i]));
      } catch {
        return null;
      }
    }
    return tijden.map((t) => puntCache.get(sleutel(t)) ?? null);
  };
}

export async function keurGezicht(
  montagePad: string,
  opties: {
    python?: { cmd: string; voor: string[] };
    perSeconden?: number;
    segmenten?: Shot[];
    /** Bronbestand; nodig om de gezichtspositie betrouwbaar te meten. */
    bronPad?: string;
    sprekerMeter?: SprekerPuntMeter;
  } = {},
): Promise<KeuringRegel> {
  void montagePad;
  return (await keurGezichtDetail(opties)).regel;
}

/** Als keurGezicht, met de foute momenten als structuur: die voeden het zelfherstel op de spreker. */
export async function keurGezichtDetail(
  opties: {
    python?: { cmd: string; voor: string[] };
    segmenten?: Shot[];
    bronPad?: string;
    sprekerMeter?: SprekerPuntMeter;
  } = {},
): Promise<{ regel: KeuringRegel; fouten: SprekerFout[] }> {
  const metFout = (regel: KeuringRegel) => ({ regel, fouten: [] as SprekerFout[] });
  const segmenten = opties.segmenten ?? [];
  if ((!opties.bronPad && !opties.sprekerMeter) || segmenten.length === 0) {
    return metFout({ naam: 'actieve spreker in beeld', goed: null, detail: 'geen bron of segmenten; niet te toetsen' });
  }
  const py = opties.python ?? { cmd: 'python3', voor: [] };

  // Meetmomenten in bróntijd: het begin van elk shot (daar zitten de fouten)
  // en daarna elke anderhalve seconde.
  const punten: { seg: Shot; t: number }[] = [];
  for (const seg of segmenten) {
    for (let t = seg.start + 0.15; t < seg.end - 0.1; t += 1.5) punten.push({ seg, t: Math.round(t * 100) / 100 });
  }
  if (punten.length === 0) {
    return metFout({ naam: 'actieve spreker in beeld', goed: null, detail: 'te kort om te toetsen' });
  }

  const meter = opties.sprekerMeter ?? sprekerPuntMeterVia(opties.bronPad as string, py);
  type Vak = GezichtVak;
  const gemetenPunten = await meter(punten.map((p) => p.t));
  if (!gemetenPunten) {
    return metFout({ naam: 'actieve spreker in beeld', goed: null, detail: 'meting mislukt; niet te toetsen' });
  }
  const metingen: GezichtPuntMeting[] = gemetenPunten;
  if (metingen.length !== punten.length) {
    return metFout({
      naam: 'actieve spreker in beeld',
      goed: null,
      detail: `meting onvolledig (${metingen.length}/${punten.length}); niet te toetsen — draait OpenCV op deze machine?`,
    });
  }

  const UIT_MIDDEN_MAX = instelling('KEURING_UIT_MIDDEN_MAX');
  const BUITEN_MAX = instelling('KEURING_BUITEN_MAX');
  const ANDERE_PERSOON = instelling('KEURING_ANDERE_PERSOON');
  const fouten: string[] = [];
  const structuur: SprekerFout[] = [];
  let getoetst = 0;
  let genegeerd = 0;
  let zonderGezicht = 0;

  // Per shot het middelpunt van de spreker bepalen, zodat een meting die de
  // gesprekspartner pakte niet als "hoofd buiten beeld" wordt geteld — dat
  // leverde een melding van 453% op, wat vooral betekent: verkeerd gezicht.
  const medianen = new Map<number, number>();
  for (const seg of segmenten) {
    const eigen = metingen
      .map((m, i) => (m && punten[i].seg.volgorde === seg.volgorde ? m.x : null))
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    if (eigen.length) medianen.set(seg.volgorde, eigen[Math.floor(eigen.length / 2)]);
  }

  for (const [i, m0] of metingen.entries()) {
    if (!m0) {
      zonderGezicht++;
      continue;
    }
    const { seg: sg0 } = punten[i];
    let m: Vak = m0;
    // Actieve spreker (sprekers.ts): niet de mond die op deze drie frames
    // toevallig bewoog, maar het gezicht op de plek waar de montage de
    // spreker verwacht. Staat daar niemand, dan kadert de montage een muur,
    // een hand of de verkeerde persoon — en dat is precies de fout.
    if (sg0.sprekerBepaald && m0.gezichten?.length) {
      const verwacht = sg0.spoor?.length
        ? sg0.spoor.reduce((a, b) => (Math.abs(b.t - punten[i].t) < Math.abs(a.t - punten[i].t) ? b : a)).x
        : (sg0.focusX ?? 0.5);
      const naast = m0.gezichten.reduce((a, b) => (Math.abs(b.x - verwacht) < Math.abs(a.x - verwacht) ? b : a));
      if (Math.abs(naast.x - verwacht) > ANDERE_PERSOON) {
        fouten.push(`${punten[i].t.toFixed(1)}s: actieve spreker niet in beeld (kader op ${verwacht.toFixed(2)}, dichtstbijzijnde gezicht ${naast.x.toFixed(2)})`);
        // Naar wie moet het kader? De spreker volgens de mondbeweging op dit
        // moment (gezichten.py kiest die), niet de dichtstbijzijnde buur.
        structuur.push({ volgorde: sg0.volgorde, t: punten[i].t, soort: 'niet_in_beeld', waarde: Math.abs(naast.x - verwacht), gezicht: { x: m0.x, breedte: m0.breedte, top: m0.top, hoogte: m0.hoogte } });
        getoetst++;
        continue;
      }
      m = naast;
    } else {
      const mediaan = medianen.get(sg0.volgorde);
      if (mediaan !== undefined && Math.abs(m.x - mediaan) > ANDERE_PERSOON) {
        // Vermoedelijk de gesprekspartner. Niet stil overslaan: als dit vaak
        // gebeurt volgt de detectie de verkeerde persoon, en dan is een groen
        // oordeel over de rest niets waard.
        genegeerd++;
        continue;
      }
    }
    getoetst++;
    const { seg, t } = punten[i];
    const paneelBreed = seg.paneel ? seg.paneel[1] - seg.paneel[0] : 1;
    const verhouding = BRON_VERHOUDING * paneelBreed;

    // Waar staat het gezicht binnen het beeld waaruit gesneden wordt?
    const fx = seg.paneel ? (m.x - seg.paneel[0]) / paneelBreed : m.x;
    const fb = m.breedte / paneelBreed;

    // Welk focuspunt gebruikt de montage op dit moment?
    const spoorPunt = seg.spoor?.length
      ? seg.spoor.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)).x
      : seg.focusX;
    const focus = seg.paneel && spoorPunt !== undefined
      ? (spoorPunt - seg.paneel[0]) / paneelBreed
      : (spoorPunt ?? 0.5);

    const u = uitsnedeVan(focus, seg.zoom ?? basisZoom(seg), seg.focusY, verhouding);
    const breedteU = u.x1 - u.x0;

    // De plek van het gezicht in het eindbeeld, en hoeveel er buiten valt.
    const inBeeld = (fx - u.x0) / breedteU;
    const buiten =
      Math.max(0, u.x0 - (fx - fb / 2)) + Math.max(0, fx + fb / 2 - u.x1);

    if (buiten > fb * BUITEN_MAX) {
      fouten.push(`${t.toFixed(1)}s: ${Math.round((buiten / fb) * 100)}% van het hoofd buiten beeld`);
      structuur.push({ volgorde: seg.volgorde, t, soort: 'buiten', waarde: buiten / fb, gezicht: { x: m.x, breedte: m.breedte, top: m.top, hoogte: m.hoogte } });
    } else if (Math.abs(inBeeld - 0.5) > UIT_MIDDEN_MAX) {
      const kant = inBeeld < 0.5 ? 'links' : 'rechts';
      fouten.push(`${t.toFixed(1)}s: ${Math.round(Math.abs(inBeeld - 0.5) * 100)}% uit het midden (${kant})`);
      structuur.push({ volgorde: seg.volgorde, t, soort: 'uit_midden', waarde: Math.abs(inBeeld - 0.5), gezicht: { x: m.x, breedte: m.breedte, top: m.top, hoogte: m.hoogte } });
    }
  }

  const gemeten = getoetst + genegeerd;
  if (gemeten === 0) {
    return metFout({
      naam: 'actieve spreker in beeld',
      goed: null,
      detail: `geen gezicht gevonden op ${zonderGezicht} meetmomenten; niet te toetsen`,
    });
  }
  const aandeelGenegeerd = genegeerd / gemeten;
  const teVeelGenegeerd = aandeelGenegeerd > instelling('KEURING_MAX_GENEGEERD');
  const telling =
    `${getoetst} momenten getoetst` +
    (genegeerd ? `, ${genegeerd} genegeerd als andere persoon (${Math.round(aandeelGenegeerd * 100)}%)` : '') +
    (zonderGezicht ? `, ${zonderGezicht} zonder gezicht` : '');

  if (teVeelGenegeerd) {
    fouten.unshift(
      `${Math.round(aandeelGenegeerd * 100)}% van de metingen wijkt af van de shot-mediaan — de detectie volgt waarschijnlijk de verkeerde persoon`,
    );
  }

  const regel: KeuringRegel = {
    naam: 'actieve spreker in beeld',
    goed: fouten.length === 0,
    detail:
      fouten.length === 0
        ? `${telling}, spreker overal binnen ${Math.round(UIT_MIDDEN_MAX * 100)}% van het midden`
        : `${telling}; ` + fouten.slice(0, 6).join('; ') + (fouten.length > 6 ? ` (+${fouten.length - 6})` : ''),
  };
  return { regel, fouten: structuur };
}

/**
 * Regel: graphics passend. Geen deelstuk zonder gezicht mag vullend
 * gekadreerd zijn — dan valt de helft van een graphic buiten beeld ("PLATIN",
 * "−39"). Gemeten los van de beslissing: per vullend deelstuk opnieuw een
 * paar momenten door de gezichtsdetectie; is er op géén enkel moment een
 * gezicht, dan is het een graphic die aangesneden wordt.
 */
/** Eén concrete fout van "graphics passend", met genoeg om hem te herstellen (herstel.ts). */
export type GraphicFout = {
  soort: 'inhoud_buiten_beeld' | 'graphic_vullend' | 'camerabeeld_passend';
  volgorde: number;
  /** Absolute brontijden van het deelstuk. */
  van: number;
  tot: number;
  wat: string;
  /** Bij inhoud_buiten_beeld: de inhoudsbox zoals na de render gemeten — het zelfherstel kadert daarmee opnieuw. */
  gemeten?: Box;
};

/**
 * Regel: graphics passend — in beide richtingen.
 *
 * - Een deelstuk zonder gezicht dat vullend gekadreerd is en op een graphic
 *   lijkt: dan valt de helft van de graphic weg ("PLATIN", "−39").
 * - Een ingezoomde graphic waarvan de (opnieuw gemeten) inhoud buiten het
 *   gerenderde gebied valt: een animatie die later uitloopt.
 * - Een camerabeeld in het passende kader: een spreker als postzegel tussen
 *   twee wazige balken.
 *
 * Gemeten los van de beslissing, op andere momenten. De structuur (fouten)
 * voedt het zelfherstel in de worker; de regel is wat de keuring toont.
 */
export async function keurGraphicsDetail(
  segmenten: Shot[],
  kader: Kader,
  meter: GezichtMeter,
  graphicMeter?: GraphicMeter,
): Promise<{ regel: KeuringRegel; fouten: GraphicFout[] }> {
  const naam = 'graphics passend';
  const fouten: GraphicFout[] = [];
  const toetsen: { volgorde: number; van: number; tot: number; tijden: number[] }[] = [];
  let graphicDelen = 0;
  let ingezoomd = 0;
  let wijd = 0;

  for (const seg of segmenten) {
    for (const d of deelstukken(seg, kader)) {
      const van = seg.start + d.van;
      const tot = seg.start + d.tot;
      const lengte = d.tot - d.van;
      if (d.kader === 'blur') {
        graphicDelen++;
        if (!graphicMeter) continue;
        const meting = await graphicMeter([0.1, 0.5, 0.9, 0.98].map((f) => van + lengte * f));
        if (d.inhoud) {
          ingezoomd++;
          // Inzoomen mag nooit inhoud kosten.
          if (meting.box && !boxBinnen(meting.box, inhoudKader(d.inhoud).r)) {
            fouten.push({ soort: 'inhoud_buiten_beeld', volgorde: seg.volgorde, van, tot, gemeten: meting.box, wat: `shot ${seg.volgorde} ${van.toFixed(1)}s: graphic-inhoud valt buiten beeld na inzoomen` });
          }
        } else if (!lijktGraphic(meting)) {
          // Ook als het hele clipkader passend gekozen was (d.gezicht niet
          // gezet): een camerabeeld in het passende kader is altijd een
          // postzegel — mukbang clip 4 stond zo bijna helemaal piepklein.
          fouten.push({ soort: 'camerabeeld_passend', volgorde: seg.volgorde, van, tot, wat: `shot ${seg.volgorde} ${van.toFixed(1)}s: camerabeeld in het passende kader (postzegel)` });
        }
        continue;
      }
      if (d.kader !== 'vullend' && d.kader !== 'staand') continue;
      const punten = lengte > 2 ? [0.2, 0.5, 0.8] : [0.5];
      toetsen.push({ volgorde: seg.volgorde, van, tot, tijden: punten.map((f) => van + lengte * f) });
    }
  }

  if (toetsen.length > 0) {
    const uitslag = await meter(toetsen.flatMap((t) => t.tijden));
    if (uitslag.every((u) => u === null) && fouten.length === 0) {
      return { regel: { naam, goed: null, detail: 'gezichtsmeting mislukt; niet te toetsen' }, fouten };
    }
    let i = 0;
    for (const t of toetsen) {
      const eigen = uitslag.slice(i, i + t.tijden.length);
      i += t.tijden.length;
      if (eigen.length > 0 && eigen.every((u) => u === false)) {
        // Geen gezicht is nog geen graphic: een wijd camerashot hoort juist
        // vullend. Alleen fout als het beeld ook op een graphic lijkt.
        const beeld = graphicMeter ? await graphicMeter(t.tijden) : null;
        if (beeld && !lijktGraphic(beeld)) {
          wijd++;
          continue;
        }
        fouten.push({ soort: 'graphic_vullend', volgorde: t.volgorde, van: t.van, tot: t.tot, wat: `shot ${t.volgorde} ${t.van.toFixed(1)}-${t.tot.toFixed(1)}s: geen gezicht maar vullend gekadreerd` });
      }
    }
  }

  return {
    regel: {
      naam,
      goed: fouten.length === 0,
      detail:
        fouten.length === 0
          ? `${toetsen.length} vullende deelstukken (${wijd} wijd camerabeeld zonder gevonden gezicht), ${graphicDelen} passend (blur), ${ingezoomd} ingezoomd op de inhoud, niets buiten beeld`
          : fouten.slice(0, 5).map((f) => f.wat).join('; '),
    },
    fouten,
  };
}

export async function keurGraphics(
  segmenten: Shot[],
  kader: Kader,
  meter: GezichtMeter,
  graphicMeter?: GraphicMeter,
): Promise<KeuringRegel> {
  return (await keurGraphicsDetail(segmenten, kader, meter, graphicMeter)).regel;
}

/** Regels 4 en 5: klinkt het script, en klinkt niets dubbel? */
/**
 * Wordt deze zin in de bron zelf ook (minstens) twee keer gezegd, binnen de
 * stukken die de clip gebruikt? Dan is de herhaling echt — een tweede
 * spreker die de vraag herhaalt — en geen knip die iets dupliceert. Ruim
 * vergeleken: de terugluistering verhaspelt woorden ("Zij jij dit dragen?"
 * voor "Zou jij dit dragen?"), dus één afwijkend woord mag.
 */
export function herhaaldInBron(tekst: string, segmenten: Shot[], bronWoorden: BronWoord[] | null): boolean {
  if (!bronWoorden?.length) return false;
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const doel = tekst.split(/\s+/).map(norm).filter(Boolean);
  if (doel.length < 3) return false;
  const bron = bronWoorden
    .filter((w) => segmenten.some((sg) => (w.s + w.e) / 2 >= sg.start - 0.3 && (w.s + w.e) / 2 <= sg.end + 0.3))
    .sort((a, b) => a.s - b.s)
    .map((w) => norm(w.w));
  let keer = 0;
  for (let i = 0; i + doel.length <= bron.length; i++) {
    let mis = 0;
    for (let k = 0; k < doel.length && mis <= 1; k++) if (bron[i + k] !== doel[k]) mis++;
    if (mis <= Math.min(1, doel.length - 2)) {
      keer++;
      i += doel.length - 1;
    }
  }
  return keer >= 2;
}

export async function keurScript(
  montagePad: string,
  segmenten: Shot[],
  bronWoorden: BronWoord[] | null = null,
): Promise<KeuringRegel[]> {
  const script = await controleerScript(montagePad, segmenten as never);
  if (!script) {
    return [{ naam: 'script gevolgd', goed: null, detail: 'niet te transcriberen; niet te toetsen' }];
  }

  // Niet teruggehoord maar wél in de bron op de knip: meetfout van de
  // terugluistering, geen ontbrekend fragment.
  const kopBron = (ps: { volgorde: number }) => {
    const seg = segmenten.find((sg) => sg.volgorde === ps.volgorde) as (Shot & { transcript_fragment?: string }) | undefined;
    return Boolean(seg?.transcript_fragment && kopInBron(seg.transcript_fragment, seg, bronWoorden));
  };
  const nietGehoord = (script.perShot ?? []).filter((ps) => !ps.gevonden);
  const inBronGezien = nietGehoord.filter(kopBron);
  const ontbreekt = nietGehoord.filter((ps) => !inBronGezien.includes(ps));
  // De cold open herhaalt de payoff met opzet; alleen herhalingen buiten het
  // eerste segment tellen.
  const teaseGrens = (segmenten[0] as { tease?: boolean } | undefined)?.tease
    ? segmenten[0].end - segmenten[0].start + 0.5
    : 0;
  const naTease = script.herhalingen.filter((h) => h.eerste > teaseGrens);
  // Een zin die in de bron zelf twee keer klinkt (een herhaalde vraag) is
  // geen dubbeling door een knip.
  const inBron = naTease.filter((h) => herhaaldInBron(h.tekst, segmenten, bronWoorden));
  const herhalingen = naTease.filter((h) => !inBron.includes(h));

  return [
    {
      naam: 'script gevolgd',
      goed: ontbreekt.length === 0,
      detail:
        (ontbreekt.length === 0
          ? `alle ${script.perShot?.length ?? 0} fragmenten terug te horen (${Math.round(script.dekking * 100)}% woorddekking)`
          : `niet terug te horen: shot ${ontbreekt.map((o) => o.volgorde).join(', ')}`) +
        (inBronGezien.length ? ` (shot ${inBronGezien.map((o) => o.volgorde).join(', ')}: kop niet verstaan bij het terugluisteren, maar staat in de bron op de knip)` : ''),
    },
    {
      naam: 'geen dubbele zinnen',
      goed: herhalingen.length === 0,
      detail:
        (herhalingen.length === 0
          ? 'geen zin klinkt twee keer'
          : herhalingen.map((h) => `"${h.tekst}" op ${h.eerste}s en ${h.tweede}s`).join('; ')) +
        (inBron.length ? ` (${inBron.map((h) => `"${h.tekst}"`).join(', ')} wordt in de bron zelf herhaald — toegestaan)` : ''),
    },
    {
      naam: 'geen vreemde aanloop',
      goed: !script.aanloop,
      detail: script.aanloop
        ? `clip begint met "${script.aanloop.tekst}" (${script.aanloop.seconden}s vóór het script)`
        : 'clip begint op de scripttekst',
    },
  ];
}

/**
 * Regel 6: elke naad is schoon — stil, óf precies op een woordgrens.
 *
 * Die tweede mogelijkheid is geen versoepeling maar een correctie op een
 * regelconflict. Praat iemand onafgebroken door, dan bestaat er geen stilte om
 * op te knippen; de enige juiste plek is dan tussen twee woorden. Zo'n naad
 * meet luid — er staat immers spraak omheen — terwijl hij precies is wat we
 * willen. Alleen een naad die noch stil is noch op een woordgrens ligt, is een
 * echte fout: dan valt hij middenin een woord.
 */
export async function keurNaden(
  montagePad: string,
  segmenten: Shot[],
  bronWoorden: BronWoord[] | null,
): Promise<KeuringRegel> {
  const eind = await controleerEindmontage(montagePad, segmenten);
  if (eind.slecht.length === 0) {
    return { naam: 'naden schoon', goed: true, detail: `alle ${eind.naden} naden stil` };
  }

  // Van elke luide naad nagaan of hij op een woordgrens ligt. De naad op de
  // tijdlijn hoort bij het eínd van een segment; dat vergelijken we met de
  // woordtijden van de bron.
  const echt: string[] = [];
  const opWoordgrens: string[] = [];
  let doorlopend = 0;
  const volg = [...segmenten].sort((a, b) => a.volgorde - b.volgorde);
  for (const s of eind.slecht) {
    let cursor = 0;
    let bronTijd: number | null = null;
    let aansluitend = false;
    for (const [i, seg] of volg.entries()) {
      cursor += seg.end - seg.start;
      if (Math.abs(cursor - s.seconde) < 0.25) {
        bronTijd = seg.end;
        // Het volgende shot begint precies waar dit eindigt (camerawissel,
        // kaderwissel): het geluid loopt door, dus een "luide naad" is hier
        // gewoon spraak — geen knip.
        aansluitend = i + 1 < volg.length && Math.abs(volg[i + 1].start - seg.end) < 0.005;
        break;
      }
    }
    if (aansluitend) {
      doorlopend++;
      continue;
    }
    const inWoord = bronTijd !== null && bronWoorden ? woordOnder(bronWoorden, bronTijd) : null;
    if (bronTijd !== null && bronWoorden && !inWoord) {
      opWoordgrens.push(`${s.seconde.toFixed(1)}s`);
    } else {
      echt.push(`${s.seconde.toFixed(1)}s (${s.db} dB)${inWoord ? ` in "${inWoord.w}"` : ''}`);
    }
  }

  return {
    naam: 'naden schoon',
    goed: echt.length === 0,
    detail:
      echt.length === 0
        ? `${eind.naden} naden: ${eind.naden - opWoordgrens.length - doorlopend} stil, ${opWoordgrens.length} op een woordgrens in doorlopende spraak${doorlopend ? `, ${doorlopend} beeldwissel(s) zonder knip in het geluid` : ''}`
        : echt.join('; ') + (doorlopend ? ` (${doorlopend} beeldwissel(s) zonder knip in het geluid niet meegeteld)` : ''),
  };
}

/** De volledige keuring van één gerenderde clip. */
export async function keurMontage(
  montagePad: string,
  segmenten: Shot[],
  bronWoorden: BronWoord[] | null,
  opties: {
    python?: { cmd: string; voor: string[] };
    bronPad?: string;
    /**
     * De retentieregel (retentie.ts → keurRetentie), gemeten op dezelfde
     * definitieve segmenten. Van buiten meegegeven omdat hij de doelen van de
     * campagne nodig heeft; ontbreekt hij, dan telt hij niet mee.
     */
    retentie?: KeuringRegel;
    /** Het clipkader; alleen dan wordt "graphics passend" getoetst. */
    kader?: Kader;
    /** Gezichtsmeter voor "graphics passend"; standaard gezichten.py op de bron. */
    gezichtMeter?: GezichtMeter;
    /** Graphic-meter (inhoud, vlakheid) voor ingezoomde graphics en wijde shots; standaard ffmpeg op de bron. */
    graphicMeter?: GraphicMeter;
    /** Waar de ondertitelregels terechtkwamen (ondertitels.ts); voedt "ondertitel over gezicht". */
    ondertitelPlekken?: Record<Plek, number> | null;
    /** De ondertitelregels zoals ze gebrand zijn; voedt "ondertitels overlappen niet". */
    ondertitelRegels?: OndertitelRegel[] | null;
    /**
     * Al gemeten "graphics passend" (het zelfherstel meet hem op precies deze
     * segmenten): hergebruiken in plaats van alles opnieuw te meten.
     */
    graphicsRegel?: KeuringRegel;
  } = {},
): Promise<Keuringsrapport> {
  const regels: KeuringRegel[] = [
    keurKnippen(segmenten, bronWoorden),
    keurFragmenten(segmenten),
    keurOverlap(segmenten),
    await keurGezicht(montagePad, { ...opties, segmenten }),
    ...(await keurScript(montagePad, segmenten, bronWoorden)),
    await keurNaden(montagePad, segmenten, bronWoorden),
    ...(opties.python
      ? [await keurScherpBegin(montagePad, [...segmenten].sort((a, b) => a.volgorde - b.volgorde)[0], scherpteMeterVia(montagePad, opties.python))]
      : []),
    ...(opties.retentie ? [opties.retentie] : []),
    ...(opties.kader ? [keurLeesbaar(segmenten, opties.kader), keurOverlay(segmenten, opties.kader)] : []),
    ...(opties.ondertitelPlekken !== undefined ? [keurOndertitelPlek(opties.ondertitelPlekken)] : []),
    ...(opties.ondertitelRegels !== undefined ? [keurOndertitelOverlap(opties.ondertitelRegels)] : []),
    ...(opties.graphicsRegel ? [opties.graphicsRegel] : []),
    ...(!opties.graphicsRegel && opties.kader && (opties.gezichtMeter || opties.bronPad)
      ? [
          await keurGraphics(
            segmenten,
            opties.kader,
            opties.gezichtMeter ?? gezichtMeterVia(opties.bronPad as string, opties.python ?? { cmd: 'python3', voor: [] }),
            opties.graphicMeter ?? (opties.bronPad ? graphicMeterVia(opties.bronPad) : undefined),
          ),
        ]
      : []),
  ];
  return { goed: regels.every((r) => r.goed === true), status: keuringStatus(regels), regels };
}

async function duurVan(pad: string): Promise<number | null> {
  const werkmap = await mkdtemp(join(tmpdir(), 'clipper-keur-'));
  try {
    const uit = await new Promise<string>((klaar) => {
      const kind = spawn(
        resolveBinary('ffprobe'),
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', pad],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let alles = '';
      kind.stdout.on('data', (d) => (alles += d));
      kind.on('error', () => klaar(''));
      kind.on('close', () => klaar(alles));
    });
    const n = Number(uit.trim());
    return Number.isFinite(n) ? n : null;
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }
}

/** Vlaggetje voor scripts: bestaat het bestand en is het niet leeg? */
export function bestaatMontage(pad: string): boolean {
  return existsSync(pad);
}
