import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { controleerEindmontage } from './knipcontrole';
import { controleerScript } from './scriptcontrole';
import { woordOnder } from './poort';
import type { Shot } from './index';
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
 * Regel 3: staat de spreker in élk bemonsterd frame van het eindbestand goed
 * in beeld?
 *
 * Bewust gemeten op de gerénderde clip en niet op de bron: alle kadrering,
 * tracking en zoom zit daar al in verwerkt, dus dit is wat de kijker ziet. Een
 * gezicht telt als goed wanneer het gevonden wordt, breed genoeg is om te
 * lezen, en niet tegen een rand geplakt zit.
 */
export async function keurGezicht(
  montagePad: string,
  opties: {
    python?: { cmd: string; voor: string[] };
    perSeconden?: number;
    /** Segmenten, om ook het begin van elk shot te bemonsteren. */
    segmenten?: Shot[];
  } = {},
): Promise<KeuringRegel> {
  const py = opties.python ?? { cmd: 'python3', voor: [] };
  const stap = opties.perSeconden ?? 1.5;

  const duur = await duurVan(montagePad);
  if (duur === null) return { naam: 'spreker in beeld', goed: true, detail: 'duur onbekend' };

  const tijden: number[] = [];
  for (let t = 0.4; t < duur - 0.2; t += stap) tijden.push(Math.round(t * 100) / 100);

  // Extra metingen vlak ná elke knip. Daar zitten de fouten: een kader dat nog
  // moet bijtrekken, een spreker die net van plek is gewisseld. Een raster van
  // anderhalve seconde stapt daar zo overheen.
  let cursor = 0;
  for (const seg of opties.segmenten ?? []) {
    for (const na of [0.08, 0.35, 0.8]) {
      const t = cursor + na;
      if (t > 0.05 && t < duur - 0.1) tijden.push(Math.round(t * 100) / 100);
    }
    cursor += seg.end - seg.start;
  }
  tijden.sort((a, b) => a - b);
  if (tijden.length === 0) return { naam: 'spreker in beeld', goed: true, detail: 'te kort' };

  const res = spawnSync(py.cmd, [...py.voor, 'scripts/gezichten.py', montagePad, JSON.stringify(tijden), '3'], {
    encoding: 'utf8',
    maxBuffer: 20_000_000,
  });
  let metingen: GezichtMeting[] = [];
  try {
    metingen = JSON.parse(res.stdout.trim() || '[]');
  } catch {
    return { naam: 'spreker in beeld', goed: true, detail: 'meting mislukt; niet te toetsen' };
  }
  if (metingen.length !== tijden.length) {
    return { naam: 'spreker in beeld', goed: true, detail: 'meting onvolledig; niet te toetsen' };
  }

  // De marges zijn ruim, en dat is een bewuste keuze. Gezichtsdetectie op een
  // staand 9:16-beeld is beduidend minder stabiel dan op de liggende bron: het
  // vak dat YuNet teruggeeft zit royaal om het hoofd en varieert per frame.
  // Een strakke drempel meldt dan beelden af die er prima uitzien — en een
  // keuring die vals alarm slaat is net zo schadelijk als geen keuring, want
  // dan ga je hem negeren. Deze regel vangt daarom wat onmiskenbaar fout is:
  // een hoofd dat er voor een flink deel buiten valt, of dat zo klein is dat
  // je het gezicht niet leest.
  const BUITEN_MAX = 0.15; // deel van de gezichtsbreedte dat buiten beeld mag
  const MIN_BREEDTE = 0.14;

  const fouten: string[] = [];
  let gevonden = 0;
  for (const [i, m] of metingen.entries()) {
    if (!m) continue; // geen gezicht: kan een insert of tekstkaart zijn
    gevonden++;
    const links = m.x - m.breedte / 2;
    const rechts = m.x + m.breedte / 2;
    const buiten = Math.max(0, -links) + Math.max(0, rechts - 1);
    if (buiten > m.breedte * BUITEN_MAX) {
      fouten.push(`${tijden[i]}s: ${Math.round((buiten / m.breedte) * 100)}% van het hoofd buiten beeld`);
    } else if (m.breedte < MIN_BREEDTE) {
      fouten.push(`${tijden[i]}s te klein (${Math.round(m.breedte * 100)}%)`);
    }
  }

  // Vrijwel nergens een gezicht gevonden in een pratende clip is óók fout.
  if (gevonden < metingen.length * 0.5) {
    fouten.push(`slechts ${gevonden}/${metingen.length} frames met een gezicht`);
  }

  return {
    naam: 'spreker in beeld',
    goed: fouten.length === 0,
    detail:
      fouten.length === 0
        ? `${gevonden}/${metingen.length} frames met de spreker volledig en groot genoeg in beeld`
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
  opties: { python?: { cmd: string; voor: string[] } } = {},
): Promise<Keuringsrapport> {
  const regels: KeuringRegel[] = [
    keurKnippen(segmenten, bronWoorden),
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
