import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { voerYtdlpUit } from '../ingest/youtube';
import { instelling } from './instellingen';

/**
 * Analysebron en renderbron gescheiden.
 *
 * De hele video in 1440p of 4K downloaden om er een minuut uit te renderen is
 * zonde van tijd en schijf, maar een 9:16-close-up uit 1080p wordt ruim 2x
 * opgeschaald en oogt zacht. Dus: de analysebron blijft de hele video in
 * 1080p (gezichten, scènes, woordtijden, stiltes — allemaal genormaliseerd of
 * in brontijd, dus resolutie-onafhankelijk), en voor het renderen worden
 * alleen de stukken gehaald die de clip echt gebruikt, in de hoogste
 * beschikbare kwaliteit (yt-dlp --download-sections).
 *
 * Precisie zonder --force-keyframes-at-cuts (dat hercodeert de hele sectie):
 * een sectie begint op het keyframe vóór het gevraagde punt, dus waar
 * t=0 van het bestand in de bron ligt is niet exact bekend. Dat meten we: de
 * audio van de sectie wordt tegen de audio van de analysebron gelegd
 * (kruiscorrelatie, eerst grof op de omhullende, dan op het sample). Beeld en
 * geluid in het sectiebestand zijn onderling synchroon (één mux), dus met
 * die ene offset klopt alles. Te weinig overeenkomst (stilte, andere mix) →
 * die sectie wordt niet gebruikt en het shot rendert uit de analysebron.
 *
 * Codec: VP9 eerst (ffmpeg decodeert het native, geen extra bibliotheek),
 * dan wat er het hoogst is — AV1 mag hier wél, want de renderbron gaat alleen
 * door ffmpeg (de CI-ffmpeg heeft dav1d; de workflow logt dat), niet door
 * OpenCV.
 */

export type Sectie = { van: number; tot: number };

export type SectieBestand = Sectie & {
  pad: string;
  /** Brontijd die hoort bij t=0 in het bestand (gemeten via de audio). */
  bronStart: number;
  /**
   * Brontijd die hoort bij t=0 van het BEELD in het bestand, apart gemeten
   * (beeld tegen beeld van de analysebron). Bij DASH haalt yt-dlp beeld en
   * geluid als twee losse stromen, elk vanaf zijn eigen keyframe; loopt dat
   * uiteen, dan kreeg een graphic het kader van de spreker en andersom.
   * Ontbreekt het (oude cache), dan gelijk aan bronStart.
   */
  videoStart?: number;
  /** Verschil beeld − geluid (s) en hoe zeker die meting is. */
  beeldVerschil?: number;
  beeldZekerheid?: number;
  /** Duur van het bestand (s). */
  duur: number;
  breedte: number;
  hoogte: number;
  codec: string;
  bytes: number;
  correlatie: number;
};

export type RenderBron = {
  secties: SectieBestand[];
  /** Megabytes die voor deze clip gedownload zijn (hergebruikte secties tellen niet). */
  mbGedownload: number;
  /** Geschatte grootte van de hele video in dezelfde kwaliteit, voor de vergelijking in de log. */
  geschatVolMb: number | null;
  /** Wat er misging, als een of meer secties niet te gebruiken waren. */
  fouten: string[];
};

/**
 * Het sectieplan: per bereik een marge aan beide kanten, overlappende of
 * nabije bereiken (gat kleiner dan RENDERBRON_SAMENVOEG_GAT) samengevoegd tot
 * één download. Grenzen binnen [0, duur].
 */
export function sectiePlan(
  bereiken: { start: number; end: number }[],
  opties: { marge?: number; samenvoegGat?: number; duur?: number | null } = {},
): Sectie[] {
  const marge = opties.marge ?? instelling('RENDERBRON_MARGE');
  const gat = opties.samenvoegGat ?? instelling('RENDERBRON_SAMENVOEG_GAT');
  const max = opties.duur ?? Infinity;
  const ruim = bereiken
    .filter((b) => b.end > b.start)
    .map((b) => ({ van: Math.max(0, b.start - marge), tot: Math.min(max, b.end + marge) }))
    .sort((a, b) => a.van - b.van);
  const uit: Sectie[] = [];
  for (const b of ruim) {
    const laatste = uit[uit.length - 1];
    if (laatste && b.van - laatste.tot < gat) laatste.tot = Math.max(laatste.tot, b.tot);
    else uit.push({ ...b });
  }
  return uit.map((s) => ({ van: Math.floor(s.van * 10) / 10, tot: Math.ceil(s.tot * 10) / 10 }));
}

/** De sectie die een brontijdvak volledig bevat (in wat er werkelijk in het bestand staat), of null. */
export function sectieVoor(secties: SectieBestand[], van: number, tot: number): SectieBestand | null {
  return (
    secties.find((s) => {
      const beeld = s.videoStart ?? s.bronStart;
      const begin = Math.max(s.bronStart, beeld);
      const eind = Math.min(s.bronStart, beeld) + s.duur;
      return begin <= van + 1e-3 && eind >= tot - 1e-3;
    }) ?? null
  );
}

/** Waar in het sectiebestand een brontijd staat — voor het geluid. */
export function sectieTijd(sectie: SectieBestand, bronTijd: number): number {
  return Math.max(0, bronTijd - sectie.bronStart);
}

/** Waar in het sectiebestand een brontijd staat — voor het beeld (eigen offset). */
export function sectieBeeldTijd(sectie: SectieBestand, bronTijd: number): number {
  return Math.max(0, bronTijd - (sectie.videoStart ?? sectie.bronStart));
}

// ------------------------------------------------------------------ beeld uitlijnen

const MINI_B = 32;
const MINI_H = 18;

function miniaturen(pad: string, van: number, duur: number, fps: number): Promise<Float32Array[] | null> {
  return new Promise((klaar) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', Math.max(0, van).toFixed(3), '-t', duur.toFixed(3), '-i', pad,
        '-an', '-vf', `fps=${fps},scale=${MINI_B}:${MINI_H}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const delen: Buffer[] = [];
    kind.stdout.on('data', (d: Buffer) => delen.push(d));
    kind.on('error', () => klaar(null));
    kind.on('close', (code) => {
      if (code !== 0) return klaar(null);
      const buf = Buffer.concat(delen);
      const n = MINI_B * MINI_H;
      const uit: Float32Array[] = [];
      for (let i = 0; i + n <= buf.length; i += n) {
        // Genormaliseerd (gemiddelde 0, spreiding 1): een 4K-VP9 en een
        // 1080p-H.264 van hetzelfde beeld verschillen iets in helderheid en contrast.
        const f = new Float32Array(n);
        let m = 0;
        for (let k = 0; k < n; k++) m += buf[i + k];
        m /= n;
        let v = 0;
        for (let k = 0; k < n; k++) v += (buf[i + k] - m) ** 2;
        const sd = Math.sqrt(v / n) || 1;
        for (let k = 0; k < n; k++) f[k] = (buf[i + k] - m) / sd;
        uit.push(f);
      }
      klaar(uit);
    });
  });
}

/**
 * Het verschil tussen waar het beeld en waar het geluid van een sectie in de
 * bron beginnen, gemeten door het beeld van de sectie tegen het beeld van de
 * analysebron te leggen (±4 s rond de audio-offset, op 0,04 s). Zeker genoeg
 * als het beste verschil duidelijk lager is dan het typische; anders null en
 * geldt de audio-offset voor beide.
 */
export async function lijnBeeldUit(
  sectiePad: string,
  analyseBron: string,
  audioStart: number,
): Promise<{ verschil: number; zekerheid: number } | null> {
  const SPEL = 4;
  // Beide op 25 fps uit hetzelfde filter; de sectie daarna in code per vijfde
  // frame. Met fps=5 op de sectie zat er een vaste afwijking van een halve
  // bemonstering (0,1 s) in de meting.
  const [sectieAlle, analyse] = await Promise.all([
    miniaturen(sectiePad, 1, 8, 25),
    miniaturen(analyseBron, Math.max(0, audioStart + 1 - SPEL), 8 + 2 * SPEL, 25),
  ]);
  const sectie = sectieAlle?.filter((_, i) => i % 5 === 0) ?? null;
  if (!sectie || !analyse || sectie.length < 10 || analyse.length < 50) return null;
  const analyseStart = Math.max(0, audioStart + 1 - SPEL);
  const scores: { verschil: number; score: number }[] = [];
  for (let stap = -SPEL * 25; stap <= SPEL * 25; stap++) {
    const verschil = stap / 25;
    let som = 0;
    let n = 0;
    sectie.forEach((f, k) => {
      const t = audioStart + verschil + 1 + k * 0.2;
      const idx = Math.round((t - analyseStart) * 25);
      const g = analyse[idx];
      if (!g) return;
      let d = 0;
      for (let p = 0; p < f.length; p++) d += Math.abs(f[p] - g[p]);
      som += d / f.length;
      n++;
    });
    if (n >= sectie.length * 0.8) scores.push({ verschil, score: som / n });
  }
  if (scores.length === 0) return null;
  const beste = scores.reduce((a, b) => (b.score < a.score ? b : a));
  const gesorteerd = [...scores].map((x) => x.score).sort((a, b) => a - b);
  const mediaan = gesorteerd[Math.floor(gesorteerd.length / 2)];
  // Een statisch beeld (een pratend hoofd dat stilzit) geeft overal ongeveer
  // hetzelfde verschil: dan weten we het niet, en dat zeggen we.
  const zekerheid = mediaan > 0 ? Math.round(((mediaan - beste.score) / mediaan) * 100) / 100 : 0;
  return { verschil: Math.round(beste.verschil * 100) / 100, zekerheid };
}

// ------------------------------------------------------------------ uitlijnen

const RATE = 8000;
const BLOK = 20; // omhullende op 400 Hz

function pcm(pad: string, van: number, duur: number): Promise<Int16Array | null> {
  return new Promise((klaar) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', Math.max(0, van).toFixed(3), '-t', duur.toFixed(3), '-i', pad,
        '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const delen: Buffer[] = [];
    kind.stdout.on('data', (d: Buffer) => delen.push(d));
    kind.on('error', () => klaar(null));
    kind.on('close', (code) => {
      if (code !== 0) return klaar(null);
      const buf = Buffer.concat(delen);
      klaar(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
  });
}

function omhullende(x: Int16Array): Float64Array {
  const n = Math.floor(x.length / BLOK);
  const uit = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < BLOK; k++) s += Math.abs(x[i * BLOK + k]);
    uit[i] = s / BLOK;
  }
  return uit;
}

/** Genormaliseerde correlatie van `a` tegen `b` vanaf positie `lag`. */
function ncc(a: ArrayLike<number>, b: ArrayLike<number>, lag: number, n: number): number {
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i + lag];
  }
  const ma = sa / n;
  const mb = sb / n;
  let t = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i + lag] - mb;
    t += da * db;
    va += da * da;
    vb += db * db;
  }
  return va > 0 && vb > 0 ? t / Math.sqrt(va * vb) : 0;
}

/**
 * Zoekt waar het begin van `sectie` in `referentie` ligt (in samples van
 * RATE): eerst grof op de omhullende over het hele zoekvenster, dan exact op
 * het sample in ±10 ms rond de grove treffer.
 */
export function zoekOffset(sectie: Int16Array, referentie: Int16Array): { lag: number; correlatie: number } | null {
  const ea = omhullende(sectie);
  const eb = omhullende(referentie);
  const n = Math.min(ea.length, Math.round((8 * RATE) / BLOK));
  if (n < 200 || eb.length < n) return null;
  let beste = { lag: 0, c: -1 };
  for (let lag = 0; lag + n <= eb.length; lag++) {
    const c = ncc(ea, eb, lag, n);
    if (c > beste.c) beste = { lag, c };
  }
  // Verfijnen op het sample.
  const grof = beste.lag * BLOK;
  const m = Math.min(sectie.length, 2 * RATE);
  let fijn = { lag: grof, c: -1 };
  for (let lag = Math.max(0, grof - 2 * BLOK); lag <= grof + 2 * BLOK; lag++) {
    if (lag + m > referentie.length) break;
    const c = ncc(sectie, referentie, lag, m);
    if (c > fijn.c) fijn = { lag, c };
  }
  return { lag: fijn.c > -1 ? fijn.lag : grof, correlatie: Math.round(beste.c * 1000) / 1000 };
}

/**
 * Brontijd van t=0 in het sectiebestand, via de audio. Het zoekvenster in de
 * analysebron loopt van ruim vóór het gevraagde begin (de sectie begint op
 * een keyframe dáárvoor) tot erna.
 */
export async function lijnSectieUit(
  sectiePad: string,
  analyseBron: string,
  gevraagdVan: number,
): Promise<{ bronStart: number; correlatie: number } | null> {
  const venster = Math.max(0, gevraagdVan - 8);
  const [a, b] = await Promise.all([pcm(sectiePad, 0, 10), pcm(analyseBron, venster, 22)]);
  if (!a || !b) return null;
  const r = zoekOffset(a, b);
  if (!r) return null;
  return { bronStart: Math.round((venster + r.lag / RATE) * 1000) / 1000, correlatie: r.correlatie };
}

// ------------------------------------------------------------------ downloaden

function probe(pad: string): Promise<{ breedte: number; hoogte: number; codec: string; duur: number } | null> {
  return new Promise((klaar) => {
    const kind = spawn(
      resolveBinary('ffprobe'),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', pad],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let uit = '';
    kind.stdout.on('data', (d) => (uit += d));
    kind.on('error', () => klaar(null));
    kind.on('close', () => {
      try {
        const j = JSON.parse(uit) as { streams?: { width: number; height: number; codec_name: string }[]; format?: { duration?: string } };
        const s = j.streams?.[0];
        if (!s) return klaar(null);
        klaar({ breedte: s.width, hoogte: s.height, codec: s.codec_name, duur: Number(j.format?.duration ?? 0) });
      } catch {
        klaar(null);
      }
    });
  });
}

const metaPad = (pad: string) => pad.replace(/\.mp4$/, '.json');

/** Eerder gedownloade secties in deze map (met hun gemeten uitlijning). */
function bekendeSecties(map: string): SectieBestand[] {
  if (!existsSync(map)) return [];
  return readdirSync(map)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(readFileSync(join(map, f), 'utf8')) as SectieBestand;
        return existsSync(s.pad) ? s : null;
      } catch {
        return null;
      }
    })
    .filter((s): s is SectieBestand => s !== null);
}

/**
 * Haalt de secties van het plan in de hoogste kwaliteit, lijnt ze uit en
 * cachet ze per video (een herrender of een volgende clip met hetzelfde stuk
 * downloadt niet opnieuw). Faalt een sectie, dan ontbreekt die gewoon: de
 * render valt voor die shots terug op de analysebron.
 */
export async function haalRenderSecties(opties: {
  sourceUrl: string;
  analyseBron: string;
  plan: Sectie[];
  map: string;
  /** Duur van de hele video, voor de schatting van de volle grootte. */
  videoDuur?: number | null;
  log?: (m: string) => void;
  /** Voor tests: vervangt yt-dlp. Moet het bestand op `pad` neerzetten. */
  downloader?: (sectie: Sectie, pad: string) => Promise<void>;
}): Promise<RenderBron> {
  const log = opties.log ?? (() => {});
  await mkdir(opties.map, { recursive: true });
  const bekend = bekendeSecties(opties.map);
  const secties: SectieBestand[] = [];
  const fouten: string[] = [];
  let bytesNieuw = 0;
  const maxH = instelling('RENDERBRON_MAX_HOOGTE');
  const timeout = instelling('RENDERBRON_TIMEOUT') * 1000;
  const minCorrelatie = instelling('RENDERBRON_MIN_CORRELATIE');

  for (const sectie of opties.plan) {
    const hergebruik = bekend.find((b) => b.bronStart <= sectie.van + 0.5 && b.bronStart + b.duur >= sectie.tot - 0.5);
    if (hergebruik) {
      secties.push(hergebruik);
      continue;
    }
    const pad = join(opties.map, `sectie-${sectie.van.toFixed(1)}-${sectie.tot.toFixed(1)}.mp4`);
    try {
      await rm(pad, { force: true });
      const download =
        opties.downloader?.(sectie, pad) ??
        voerYtdlpUit([
          '--no-warnings', '--force-overwrites', '--no-part',
          '--extractor-args', 'youtube:player_client=default,tv',
          '-f',
          `bv*[height<=${maxH}][vcodec^=vp09]+ba[ext=m4a]/bv*[height<=${maxH}][vcodec^=vp9]+ba[ext=m4a]/` +
            `bv*[height<=${maxH}]+ba[ext=m4a]/bv*[height<=${maxH}]+ba/b[height<=${maxH}]/b`,
          '--download-sections', `*${sectie.van.toFixed(2)}-${sectie.tot.toFixed(2)}`,
          '--merge-output-format', 'mp4',
          '-o', pad,
          opties.sourceUrl,
        ]).then(() => undefined);
      // De timer altijd opruimen: een openstaande timer houdt het proces
      // (worker, test) nog minuten in leven nadat alles klaar is.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          download,
          new Promise<never>((_, weg) => {
            timer = setTimeout(() => weg(new Error(`time-out na ${timeout / 1000} s`)), timeout);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!existsSync(pad)) throw new Error('geen bestand na download');
      const info = await probe(pad);
      if (!info || info.duur <= 0) throw new Error('bestand niet leesbaar');
      const uitgelijnd = await lijnSectieUit(pad, opties.analyseBron, sectie.van);
      if (!uitgelijnd || uitgelijnd.correlatie < minCorrelatie) {
        throw new Error(`audio-uitlijning onzeker (correlatie ${uitgelijnd?.correlatie ?? '—'})`);
      }
      const bytes = statSync(pad).size;
      bytesNieuw += bytes;
      // Het beeld apart uitlijnen: alleen een zekere meting mag de audio-offset
      // voor het beeld overrulen.
      const beeld = await lijnBeeldUit(pad, opties.analyseBron, uitgelijnd.bronStart);
      const beeldTelt = beeld && beeld.zekerheid >= instelling('RENDERBRON_BEELD_ZEKERHEID') && Math.abs(beeld.verschil) >= 0.06;
      const bestand: SectieBestand = {
        ...sectie,
        pad,
        ...info,
        bytes,
        bronStart: uitgelijnd.bronStart,
        videoStart: beeldTelt ? Math.round((uitgelijnd.bronStart + beeld.verschil) * 1000) / 1000 : uitgelijnd.bronStart,
        beeldVerschil: beeld?.verschil,
        beeldZekerheid: beeld?.zekerheid,
        correlatie: uitgelijnd.correlatie,
      };
      writeFileSync(metaPad(pad), JSON.stringify(bestand));
      secties.push(bestand);
      log(
        `renderbron: sectie ${sectie.van.toFixed(1)}-${sectie.tot.toFixed(1)} s → ${info.breedte}x${info.hoogte} ${info.codec}, ` +
          `${(bytes / 1e6).toFixed(1)} MB, geluid begint op ${bestand.bronStart.toFixed(3)} s (correlatie ${uitgelijnd.correlatie}), ` +
          (beeld
            ? `beeld ${beeld.verschil >= 0 ? '+' : ''}${beeld.verschil.toFixed(2)} s t.o.v. geluid (zekerheid ${beeld.zekerheid}${beeldTelt ? ', gecorrigeerd' : ''})`
            : 'beeld niet uit te lijnen (geldt de geluidsoffset)'),
      );
    } catch (e) {
      const fout = `sectie ${sectie.van.toFixed(1)}-${sectie.tot.toFixed(1)}: ${(e as Error).message.slice(0, 160)}`;
      fouten.push(fout);
      log(`renderbron: ${fout} — die shots renderen uit de analysebron`);
    }
  }

  // Schatting van de volle video in dezelfde kwaliteit: bytes per seconde van
  // wat er binnenkwam, maal de lengte van de video.
  const totaalBytes = secties.reduce((t, s) => t + s.bytes, 0);
  const totaalDuur = secties.reduce((t, s) => t + s.duur, 0);
  const geschatVolMb =
    opties.videoDuur && totaalDuur > 0 ? Math.round(((totaalBytes / totaalDuur) * opties.videoDuur) / 1e6) : null;
  return { secties, mbGedownload: Math.round((bytesNieuw / 1e6) * 10) / 10, geschatVolMb, fouten };
}
