import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { controleerEindmontage } from './knipcontrole';
import { controleerScript } from './scriptcontrole';
import { woordOnder } from './poort';
import { uitsnedeVan } from './kadercontrole';
import { basisZoom } from './index';
import type { Shot } from './index';

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
  goed: boolean;
  detail: string;
};

export type Keuringsrapport = {
  goed: boolean;
  regels: KeuringRegel[];
};

/** Regel 1: geen enkele knip mag binnen een woord vallen. */
export function keurKnippen(segmenten: Shot[], bronWoorden: BronWoord[] | null): KeuringRegel {
  if (!bronWoorden || bronWoorden.length === 0) {
    return { naam: 'knippen op woordgrenzen', goed: true, detail: 'geen brontranscriptie; niet te toetsen' };
  }

  const fouten: string[] = [];
  for (const seg of segmenten) {
    const s = woordOnder(bronWoorden, seg.start);
    if (s) fouten.push(`shot ${seg.volgorde} start in "${s.w}"`);
    const e = woordOnder(bronWoorden, seg.end);
    if (e) fouten.push(`shot ${seg.volgorde} eind in "${e.w}"`);
  }

  return {
    naam: 'knippen op woordgrenzen',
    goed: fouten.length === 0,
    detail: fouten.length === 0 ? `${segmenten.length * 2} grenzen, geen enkele in een woord` : fouten.join('; '),
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
export async function keurGezicht(
  montagePad: string,
  opties: {
    python?: { cmd: string; voor: string[] };
    perSeconden?: number;
    segmenten?: Shot[];
    /** Bronbestand; nodig om de gezichtspositie betrouwbaar te meten. */
    bronPad?: string;
  } = {},
): Promise<KeuringRegel> {
  const segmenten = opties.segmenten ?? [];
  if (!opties.bronPad || segmenten.length === 0) {
    return { naam: 'spreker gecentreerd', goed: true, detail: 'geen bron of segmenten; niet te toetsen' };
  }
  const py = opties.python ?? { cmd: 'python3', voor: [] };

  // Meetmomenten in bróntijd: het begin van elk shot (daar zitten de fouten)
  // en daarna elke anderhalve seconde.
  const punten: { seg: Shot; t: number }[] = [];
  for (const seg of segmenten) {
    for (let t = seg.start + 0.15; t < seg.end - 0.1; t += 1.5) punten.push({ seg, t });
  }
  if (punten.length === 0) {
    return { naam: 'spreker gecentreerd', goed: true, detail: 'te kort om te toetsen' };
  }

  const res = spawnSync(
    py.cmd,
    [...py.voor, 'scripts/gezichten.py', opties.bronPad, JSON.stringify(punten.map((p) => p.t)), '3'],
    { encoding: 'utf8', maxBuffer: 20_000_000 },
  );
  let metingen: ({ x: number; breedte: number; top: number; hoogte: number } | null)[] = [];
  try {
    metingen = JSON.parse(res.stdout.trim() || '[]');
  } catch {
    return { naam: 'spreker gecentreerd', goed: true, detail: 'meting mislukt; niet te toetsen' };
  }
  if (metingen.length !== punten.length) {
    return { naam: 'spreker gecentreerd', goed: true, detail: 'meting onvolledig; niet te toetsen' };
  }

  const UIT_MIDDEN_MAX = 0.14;
  const BUITEN_MAX = 0.15;
  const fouten: string[] = [];
  let getoetst = 0;

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

  for (const [i, m] of metingen.entries()) {
    if (!m) continue;
    const { seg: sg0 } = punten[i];
    const mediaan = medianen.get(sg0.volgorde);
    if (mediaan !== undefined && Math.abs(m.x - mediaan) > 0.28) continue; // andere persoon
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
    } else if (Math.abs(inBeeld - 0.5) > UIT_MIDDEN_MAX) {
      const kant = inBeeld < 0.5 ? 'links' : 'rechts';
      fouten.push(`${t.toFixed(1)}s: ${Math.round(Math.abs(inBeeld - 0.5) * 100)}% uit het midden (${kant})`);
    }
  }

  void montagePad;
  return {
    naam: 'spreker gecentreerd',
    goed: fouten.length === 0,
    detail:
      fouten.length === 0
        ? `${getoetst} momenten getoetst, spreker overal binnen ${Math.round(UIT_MIDDEN_MAX * 100)}% van het midden`
        : fouten.slice(0, 6).join('; ') + (fouten.length > 6 ? ` (+${fouten.length - 6})` : ''),
  };
}

/** Regels 4 en 5: klinkt het script, en klinkt niets dubbel? */
export async function keurScript(
  montagePad: string,
  segmenten: Shot[],
): Promise<KeuringRegel[]> {
  const script = await controleerScript(montagePad, segmenten as never);
  if (!script) {
    return [{ naam: 'script gevolgd', goed: true, detail: 'niet te transcriberen; niet te toetsen' }];
  }

  const ontbreekt = (script.perShot ?? []).filter((ps) => !ps.gevonden);
  // De cold open herhaalt de payoff met opzet; alleen herhalingen buiten het
  // eerste segment tellen.
  const teaseGrens = (segmenten[0] as { tease?: boolean } | undefined)?.tease
    ? segmenten[0].end - segmenten[0].start + 0.5
    : 0;
  const herhalingen = script.herhalingen.filter((h) => h.eerste > teaseGrens);

  return [
    {
      naam: 'script gevolgd',
      goed: ontbreekt.length === 0,
      detail:
        ontbreekt.length === 0
          ? `alle ${script.perShot?.length ?? 0} fragmenten terug te horen (${Math.round(script.dekking * 100)}% woorddekking)`
          : `niet terug te horen: shot ${ontbreekt.map((o) => o.volgorde).join(', ')}`,
    },
    {
      naam: 'geen dubbele zinnen',
      goed: herhalingen.length === 0,
      detail:
        herhalingen.length === 0
          ? 'geen zin klinkt twee keer'
          : herhalingen.map((h) => `"${h.tekst}" op ${h.eerste}s en ${h.tweede}s`).join('; '),
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
  for (const s of eind.slecht) {
    let cursor = 0;
    let bronTijd: number | null = null;
    for (const seg of segmenten) {
      cursor += seg.end - seg.start;
      if (Math.abs(cursor - s.seconde) < 0.25) {
        bronTijd = seg.end;
        break;
      }
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
        ? `${eind.naden} naden: ${eind.naden - opWoordgrens.length} stil, ${opWoordgrens.length} op een woordgrens in doorlopende spraak`
        : echt.join('; '),
  };
}

/** De volledige keuring van één gerenderde clip. */
export async function keurMontage(
  montagePad: string,
  segmenten: Shot[],
  bronWoorden: BronWoord[] | null,
  opties: { python?: { cmd: string; voor: string[] }; bronPad?: string } = {},
): Promise<Keuringsrapport> {
  const regels: KeuringRegel[] = [
    keurKnippen(segmenten, bronWoorden),
    keurFragmenten(segmenten),
    keurOverlap(segmenten),
    await keurGezicht(montagePad, { ...opties, segmenten }),
    ...(await keurScript(montagePad, segmenten)),
    await keurNaden(montagePad, segmenten, bronWoorden),
  ];
  return { goed: regels.every((r) => r.goed), regels };
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
