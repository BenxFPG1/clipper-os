import { spawn } from 'node:child_process';
import { resolveBinary } from '../ingest/binaries';
import type { Shot } from './index';
import type { Stilte } from './snap';

/**
 * Controleert of de knippen werkelijk in een spraakpauze vallen — door ernaar
 * te luisteren, niet door aan te nemen dat de berekening klopte.
 *
 * Waarom dit nodig is: het knippunt wordt bepaald uit een lijst gemeten
 * stiltes, en elke stap daarna (uitlijning, dode lucht, in- en uitloop) kan het
 * weer een fractie verschuiven. Eén zo'n fractie is genoeg om middenin een
 * lettergreep te belanden. De enige harde toets is: hoe luid is het precies op
 * het knippunt? Stilte zit rond -45 dB, spraak rond -25.
 *
 * Meten kost een handvol ffmpeg-aanroepen van een fractie van een seconde en
 * geen enkele AI-call, dus dit mag streng zijn.
 */

/** Boven dit niveau beschouwen we een knippunt als "middenin de spraak". */
const DREMPEL_DB = -38;

/** Hoe lang we luisteren aan de buitenkant van de knip. */
const VENSTER = 0.16;

export type KnipOordeel = {
  volgorde: number;
  kant: 'begin' | 'eind';
  seconde: number;
  db: number;
  goed: boolean;
};

/**
 * Meet het geluidsniveau net buiten de knip: vóór een beginpunt en ná een
 * eindpunt. Daar hoort stilte te zijn — dat is precies het stukje dat de kijker
 * niet meer hoort, en waar een half woord zou blijven hangen.
 */
export async function meetKnippunt(
  bronBestand: string,
  seconde: number,
  kant: 'begin' | 'eind',
): Promise<number> {
  const start = kant === 'begin' ? Math.max(0, seconde - VENSTER) : seconde;

  const uit = await new Promise<string>((klaar) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      ['-nostdin', '-ss', start.toFixed(3), '-t', VENSTER.toFixed(3), '-i', bronBestand,
        '-af', 'volumedetect', '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let alles = '';
    kind.stdout.on('data', (d) => (alles += d));
    kind.stderr.on('data', (d) => (alles += d));
    kind.on('error', () => klaar(''));
    kind.on('close', () => klaar(alles));
  });

  const m = uit.match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : -99;
}

/** Beoordeelt alle knippen van een montage. */
export async function beoordeelKnippen(
  bronBestand: string,
  segmenten: Shot[],
): Promise<KnipOordeel[]> {
  const uit: KnipOordeel[] = [];

  for (const [i, seg] of segmenten.entries()) {
    // Het begin van een vervolgsegment dat direct op het vorige aansluit is
    // geen hoorbare knip: daar loopt het geluid gewoon door.
    const sluitAan = i > 0 && Math.abs((segmenten[i - 1].end ?? 0) - seg.start) < 0.02;

    if (!sluitAan) {
      const db = await meetKnippunt(bronBestand, seg.start, 'begin');
      uit.push({ volgorde: seg.volgorde, kant: 'begin', seconde: seg.start, db, goed: db <= DREMPEL_DB });
    }
    const dbEind = await meetKnippunt(bronBestand, seg.end, 'eind');
    uit.push({ volgorde: seg.volgorde, kant: 'eind', seconde: seg.end, db: dbEind, goed: dbEind <= DREMPEL_DB });
  }

  return uit;
}

/**
 * Verschuift een knippunt naar de dichtstbijzijnde échte pauze, en steeds
 * verder als het daar nog niet stil is.
 *
 * Alleen naar buiten toe: een knip naar binnen schuiven kost een woord dat het
 * script wél wil hebben. Dat is de afweging die deze hele keten stuurt — liever
 * een halve seconde extra lucht dan een afgekapt woord.
 */
export function verschuifNaarPauze(
  seconde: number,
  kant: 'begin' | 'eind',
  stiltes: Stilte[],
  alGeprobeerd: number[],
  /**
   * Hoe ver het knippunt hoogstens mag opschuiven. Bewust krap: een ruime
   * marge klinkt aantrekkelijk ("dan vindt hij altijd wel een pauze") maar
   * sleept hele zinnen mee die niet in het script staan. Liever een knip die
   * niet perfect valt dan een clip die iets anders zegt.
   */
  maxAfstand = 1.2,
): number | null {
  // Alleen pauzes van betekenis; korte dipjes zijn medeklinkers, geen pauzes.
  const echt = stiltes.filter((s) => s.end - s.start >= 0.25);

  const kandidaten = echt
    .map((s) => {
      // Midden in de pauze landen, niet op de rand: dan houdt hij aan beide
      // kanten stilte over, ook als de meting er een paar honderdste naast zit.
      const punt = (s.start + s.end) / 2;
      return { punt, afstand: Math.abs(punt - seconde) };
    })
    .filter((k) => k.afstand <= maxAfstand)
    .filter((k) => (kant === 'begin' ? k.punt <= seconde + 0.05 : k.punt >= seconde - 0.05))
    .filter((k) => !alGeprobeerd.some((p) => Math.abs(p - k.punt) < 0.02))
    .sort((a, b) => a.afstand - b.afstand);

  return kandidaten[0]?.punt ?? null;
}

/**
 * Controleert de gerenderde clip zelf: valt elke naad op de tijdlijn in een
 * pauze?
 *
 * De controle hiervóór meet in de bron, vóór alle bewerkingen. Deze meet het
 * bestand dat je daadwerkelijk krijgt — inclusief fades, ducking en luidheid.
 * Als de keten ergens iets stuk maakt wat in de bron nog goed was, is dit de
 * plek waar dat aan het licht komt.
 */
export async function controleerEindmontage(
  montagePad: string,
  segmenten: Shot[],
): Promise<{ naden: number; slecht: { seconde: number; db: number }[] }> {
  // Relatief toetsen, niet absoluut. De montage normaliseert de luidheid, dus
  // een dal van -50 dB in de bron staat in het eindbestand op -35. Een vaste
  // drempel meldt dan van alles wat prima klinkt. Waar het om gaat is of de
  // uitloop stiller is dan de spraak in dezelfde clip.
  const gemiddelde = await meetGemiddelde(montagePad);
  const grens = gemiddelde === null ? DREMPEL_DB : gemiddelde - 8;

  const slecht: { seconde: number; db: number }[] = [];
  let cursor = 0;
  let naden = 0;

  for (const [i, seg] of segmenten.entries()) {
    cursor += seg.end - seg.start;
    // De laatste naad is het einde van de clip; daar valt niets te horen.
    if (i === segmenten.length - 1) break;
    naden++;

    // Alleen de uitloop meten, niet over de naad heen. Het volgende shot begint
    // per definitie op een woord — dat is geen fout maar precies de bedoeling.
    // Waar een afgekapt woord te horen zou zijn, is de laatste fractie vóór de
    // naad.
    const db = await meetKnippunt(montagePad, cursor, 'begin');
    if (db > grens) slecht.push({ seconde: cursor, db });
  }

  return { naden, slecht };
}

/**
 * Zoekt het stilste moment rond een knippunt, ook als er geen echte pauze is.
 *
 * Praat iemand onafgebroken door, dan bestaat er geen stilte om op te knippen —
 * maar er is altijd een dal: de sluiting van een medeklinker, de adem tussen
 * twee woorden. Knippen op dat dal klinkt hoorbaar beter dan knippen op een
 * klinker, ook al staat het niveau nog steeds boven de drempel.
 *
 * We lezen de golfvorm zelf uit (ruwe PCM op 8 kHz) en rekenen per 20 ms de
 * energie uit. Dat is nauwkeuriger dan wat een stiltedetector met een vaste
 * drempel kan zeggen, en het kost één ffmpeg-aanroep van een halve seconde.
 */
export async function zoekStilstePunt(
  bronBestand: string,
  seconde: number,
  kant: 'begin' | 'eind',
  straal = 0.5,
): Promise<{ seconde: number; db: number } | null> {
  const van = Math.max(0, seconde - straal);
  const duur = straal * 2;

  const pcm = await new Promise<Buffer>((klaar) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      ['-nostdin', '-ss', van.toFixed(3), '-t', duur.toFixed(3), '-i', bronBestand,
        '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const delen: Buffer[] = [];
    kind.stdout.on('data', (d: Buffer) => delen.push(d));
    kind.on('error', () => klaar(Buffer.alloc(0)));
    kind.on('close', () => klaar(Buffer.concat(delen)));
  });

  const monsters = Math.floor(pcm.length / 2);
  if (monsters < 800) return null;

  const perBlok = 160; // 20 ms bij 8 kHz
  const blokken: { t: number; db: number }[] = [];
  for (let i = 0; i + perBlok <= monsters; i += perBlok) {
    let som = 0;
    for (let k = 0; k < perBlok; k++) {
      const waarde = pcm.readInt16LE((i + k) * 2) / 32768;
      som += waarde * waarde;
    }
    const rms = Math.sqrt(som / perBlok);
    blokken.push({ t: van + i / 8000, db: 20 * Math.log10(Math.max(rms, 1e-6)) });
  }
  if (blokken.length === 0) return null;

  // Alleen naar buiten toe: een knip naar binnen kost een woord uit het script.
  const bruikbaar = blokken.filter((b) => (kant === 'begin' ? b.t <= seconde : b.t >= seconde));
  if (bruikbaar.length === 0) return null;

  const beste = bruikbaar.reduce((a, b) => (b.db < a.db ? b : a));
  // Alleen verschuiven als het merkbaar stiller is dan waar we nu staan.
  return beste.db < -30 ? { seconde: beste.t + 0.01, db: Math.round(beste.db * 10) / 10 } : null;
}

/** Het gemiddelde niveau van een heel bestand; ijkpunt voor de naadcontrole. */
async function meetGemiddelde(pad: string): Promise<number | null> {
  const uit = await new Promise<string>((klaar) => {
    const kind = spawn(resolveBinary('ffmpeg'), ['-nostdin', '-i', pad, '-af', 'volumedetect', '-f', 'null', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let alles = '';
    kind.stdout.on('data', (d) => (alles += d));
    kind.stderr.on('data', (d) => (alles += d));
    kind.on('error', () => klaar(''));
    kind.on('close', () => klaar(alles));
  });
  const m = uit.match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
}
