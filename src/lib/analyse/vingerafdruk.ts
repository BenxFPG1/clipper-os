import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { structuredCall } from '../claude';
import { CLAUDE_LICHT_MODEL } from '../env';
import { resolveBinary } from '../ingest/binaries';
import { probeDuur } from '../roughcut/frames';

/**
 * De edit-vingerafdruk: meetbare montagekenmerken van één clip.
 *
 * Waarom meten in plaats van beschrijven: "snel geknipt, veel tekst" zegt een
 * model over bijna elke virale clip. Pas als je het in getallen vastlegt
 * (eerste wissel op 0,8 s, 4 wissels per 10 s, 95% van de tijd tekst in
 * beeld) kun je top-clips tegen gewone clips van hetzelfde account afzetten
 * en zien wat écht verschilt. Die vergelijking doet src/lib/vault/normen.ts.
 *
 * Het mechanische deel (ffmpeg) is gratis en deterministisch; het visuele
 * deel (tekst in beeld, kader) is één lichte vision-call en optioneel.
 * Dezelfde functie meet externe clips én onze eigen renders, zodat beide
 * kanten van de vergelijking met dezelfde meetlat gemeten zijn.
 */

/** Ophogen als een meting anders gaat rekenen: oude en nieuwe getallen zijn dan niet meer vergelijkbaar. */
export const VINGERAFDRUK_VERSIE = 1;

/** Langer dan dit is geen short-form; zulke metingen horen niet in de normen (zie vondsten.ts). */
export const MAX_SHORTFORM_S = Number(process.env.VINGERAFDRUK_MAX_DUUR_S ?? 180);

/**
 * Wanneer telt een verandering in beeld als wissel? Eén vaste drempel werkt
 * niet: een jump cut in talking-head-materiaal (zelfde spreker, iets ander
 * kader) scoort maar 0,06–0,12, terwijl camerabeweging of een zwaaiende hand
 * óók 0,04–0,05 haalt — alleen dan frame na frame. Het verschil is de piek:
 * een knip steekt boven zijn directe omgeving uit, beweging niet. Daarom:
 * boven HARD altijd, boven ZACHT alleen als hij een piek is t.o.v. de mediaan
 * van de seconde eromheen. (Getoetst op echte TikToks: een finance-talking-
 * head met 6 jump cuts/lijst-updates, en een statisch interview met 0.)
 */
const SCENE_HARD = 0.3;
const SCENE_ZACHT = Number(process.env.VINGERAFDRUK_SCENE_DREMPEL ?? 0.055);
const PIEK_FACTOR = 2.5;
/** Twee wissels binnen deze afstand zijn één overgang (fade, flits, dubbele detectie). */
const MIN_WISSEL_AFSTAND_S = 0.25;
/** Pauzes korter dan dit zijn ademhaling, geen gat dat een kijker voelt. */
const PAUZE_MIN_S = 0.4;
/** Stilte-niveau. Met achtergrondmuziek vindt dit weinig; dat is eerlijk — dan is er ook geen hoorbaar gat. */
const STILTE_DB = -35;

export type TekstSoort = 'ondertitel' | 'hooktekst' | 'label' | 'geen';
export type Kader = 'close' | 'medium' | 'wijd' | 'graphic' | 'split';

export type VisueleVingerafdruk = {
  frames: { seconde: number; tekst_in_beeld: boolean; soort: TekstSoort; kader: Kader }[];
  ondertitelstijl: 'woord-voor-woord' | 'zin' | 'geen';
  ondertitel_positie: 'boven' | 'midden' | 'onder' | 'geen';
  /** Het kader dat het vaakst voorkomt. */
  kader: Kader;
  beweging_zoom_zichtbaar: boolean;
  broll: boolean;
  /** Wat de kijker in frame 0 ziet, in één zin. */
  eerste_frame_hook: string;
  /** Afgeleid: aandeel van de tijd met tekst in beeld (0..1), gewogen naar de tijd die elk frame vertegenwoordigt. */
  tekstInBeeldAandeel: number;
  /** Afgeleid: langste stuk zonder tekst in beeld (schatting uit de frames). */
  langsteZonderTekstS: number;
  /** Afgeleid: staat er al tekst in het allereerste frame? */
  tekstInEersteFrame: boolean;
};

export type Vingerafdruk = {
  versie: number;
  gemeten_at: string;
  duurS: number;
  /** Tijdstippen van visuele wissels (ontdubbeld). */
  wissels: number[];
  aantalWissels: number;
  wisselsPer10s: number;
  wisselsEerste3s: number;
  /** Seconde van de eerste wissel; zonder enige wissel de hele duur (de kijker wacht dan ook zo lang). */
  eersteWisselS: number;
  gemShotS: number;
  mediaanShotS: number;
  langsteZonderWisselS: number;
  /** Eerste gesproken woord (transcript) of einde van de openingsstilte. */
  spraakStartS: number | null;
  pauzesAantal: number;
  pauzesTotaalS: number;
  pauzesPerMin: number;
  /** Waar de pauzes vandaan komen: woordtijden zijn preciezer dan stiltedetectie (die muziek niet ziet als pauze). */
  pauzeBron: 'woorden' | 'stilte';
  loudnessI: number | null;
  loudnessLRA: number | null;
  woordenPerS: number | null;
  visueel: VisueleVingerafdruk | null;
  /** Waarom visueel of tempo ontbreekt, als dat zo is. Stil falen maakt normen onverklaarbaar. */
  opmerkingen: string[];
};

export type Woord = { w: string; start: number; end: number };

/**
 * Meet een videobestand dat al op schijf staat.
 *
 * transcriptWoorden: geef ze mee als je ze hebt (eigen renders hebben
 * woordtijden); dan zijn tempo, spraakstart en pauzes exact. Zonder
 * transcriberen we zelf via de gratis whisper-route (Groq free tier of lokaal);
 * faalt dat, dan blijft woordenPerS leeg in plaats van dat de meting klapt.
 */
export async function vingerafdrukVanBestand(
  pad: string,
  opties: { transcriptWoorden?: Woord[]; visueel?: boolean; transcriberen?: boolean } = {},
): Promise<Vingerafdruk> {
  const opmerkingen: string[] = [];
  const duur = await probeDuur(pad);
  if (!duur || duur <= 0) throw new Error(`duur onbekend (ffprobe kon ${pad} niet lezen)`);

  const [wissels, audio] = await Promise.all([zoekWissels(pad, duur), meetAudio(pad)]);
  const shot = shotStatistiek(wissels, duur);

  // Tempo en pauzes: woordtijden als die er zijn, anders zelf transcriberen.
  const woorden = opties.transcriptWoorden ?? null;
  let segmenten: { start: number; end: number; tekst: string }[] | null = null;
  if (!woorden && opties.transcriberen !== false) {
    try {
      const { transcribeLocalFile } = await import('../ingest/whisper');
      const seg = await transcribeLocalFile(pad);
      segmenten = seg.map((s) => ({ start: s.start_seconds, end: s.end_seconds, tekst: s.text }));
    } catch (e) {
      opmerkingen.push(`transcriptie mislukt: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  const tempo = spraakMaten({ woorden, segmenten, audio, duur });

  let visueel: VisueleVingerafdruk | null = null;
  if (opties.visueel !== false) {
    try {
      visueel = await meetVisueel(pad, duur);
    } catch (e) {
      opmerkingen.push(`visueel mislukt: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  return {
    versie: VINGERAFDRUK_VERSIE,
    gemeten_at: new Date().toISOString(),
    duurS: rond(duur, 2),
    wissels: wissels.map((t) => rond(t, 2)),
    aantalWissels: wissels.length,
    wisselsPer10s: rond((wissels.length / duur) * 10, 2),
    wisselsEerste3s: wissels.filter((t) => t < 3).length,
    eersteWisselS: rond(wissels[0] ?? duur, 2),
    gemShotS: rond(shot.gem, 2),
    mediaanShotS: rond(shot.mediaan, 2),
    langsteZonderWisselS: rond(shot.langste, 2),
    spraakStartS: tempo.spraakStartS === null ? null : rond(tempo.spraakStartS, 2),
    pauzesAantal: tempo.pauzes.length,
    pauzesTotaalS: rond(tempo.pauzes.reduce((a, p) => a + p, 0), 2),
    pauzesPerMin: rond((tempo.pauzes.length / duur) * 60, 2),
    pauzeBron: tempo.pauzeBron,
    loudnessI: audio.loudnessI,
    loudnessLRA: audio.loudnessLRA,
    woordenPerS: tempo.woordenPerS === null ? null : rond(tempo.woordenPerS, 2),
    visueel,
    opmerkingen,
  };
}

/* ------------------------------------------------------------- mechanisch */

async function zoekWissels(pad: string, duur: number): Promise<number[]> {
  // Verkleind analyseren: de scènescore verandert nauwelijks op 320 breed
  // (gemeten: <0,005 verschil), en het scheelt op 1080p een factor tien.
  const uit = await ffmpegStderr(
    ['-nostdin', '-i', pad, '-an', '-vf', "scale=320:-2,select='gte(scene,0)',metadata=print:file=-", '-f', 'null', '-'],
    true,
  );
  return ontdubbelWissels(wisselsUitScores(parseScores(uit)), duur);
}

/** Puur: 'pts_time:x' gevolgd door 'lavfi.scene_score=y' per frame. */
export function parseScores(uit: string): { t: number; s: number }[] {
  const scores: { t: number; s: number }[] = [];
  let t: number | null = null;
  for (const regel of uit.split('\n')) {
    const tm = regel.match(/pts_time:([\d.]+)/);
    if (tm) t = Number(tm[1]);
    const sm = regel.match(/scene_score=([\d.]+)/);
    if (sm && t !== null) {
      scores.push({ t, s: Number(sm[1]) });
      t = null;
    }
  }
  return scores;
}

/** Puur: pieken in de scènescore (zie SCENE_HARD/SCENE_ZACHT). */
export function wisselsUitScores(scores: { t: number; s: number }[]): number[] {
  const uit: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const { t, s } = scores[i];
    if (s >= SCENE_HARD) {
      uit.push(t);
      continue;
    }
    if (s < SCENE_ZACHT) continue;
    const buren = scores.filter((x, j) => j !== i && Math.abs(x.t - t) <= 0.5).map((x) => x.s);
    const omgeving = mediaanVan(buren) ?? 0;
    if (s >= PIEK_FACTOR * Math.max(omgeving, 0.01)) uit.push(t);
  }
  return uit;
}

/** Puur, voor de test: sorteert, gooit de openingsframe en dubbele detecties weg. */
export function ontdubbelWissels(ruw: number[], duur: number): number[] {
  const uit: number[] = [];
  for (const t of [...ruw].sort((a, b) => a - b)) {
    // Frame 0 en de allerlaatste frames zijn geen knip maar begin/eind.
    if (t < 0.1 || t > duur - 0.05) continue;
    if (uit.length > 0 && t - uit[uit.length - 1] < MIN_WISSEL_AFSTAND_S) continue;
    uit.push(t);
  }
  return uit;
}

/** Puur: shotlengtes tussen begin, wissels en eind. */
export function shotStatistiek(wissels: number[], duur: number): { gem: number; mediaan: number; langste: number } {
  const grenzen = [0, ...wissels, duur];
  const lengtes = grenzen.slice(1).map((t, i) => t - grenzen[i]).filter((l) => l > 0);
  if (lengtes.length === 0) return { gem: duur, mediaan: duur, langste: duur };
  return {
    gem: lengtes.reduce((a, b) => a + b, 0) / lengtes.length,
    mediaan: mediaanVan(lengtes) ?? duur,
    langste: Math.max(...lengtes),
  };
}

type AudioMeting = {
  stiltes: { start: number; eind: number }[];
  loudnessI: number | null;
  loudnessLRA: number | null;
};

async function meetAudio(pad: string): Promise<AudioMeting> {
  const uit = await ffmpegStderr([
    '-nostdin', '-i', pad, '-vn',
    '-af', `silencedetect=noise=${STILTE_DB}dB:d=${PAUZE_MIN_S},ebur128`,
    '-f', 'null', '-',
  ]);
  return parseAudio(uit);
}

/** Puur: leest silencedetect- en ebur128-uitvoer. Zonder audiospoor is alles leeg, geen fout. */
export function parseAudio(uit: string): AudioMeting {
  const stiltes: { start: number; eind: number }[] = [];
  let open: number | null = null;
  for (const regel of uit.split('\n')) {
    const s = regel.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) open = Math.max(0, Number(s[1]));
    const e = regel.match(/silence_end:\s*([\d.]+)/);
    if (e && open !== null) {
      stiltes.push({ start: open, eind: Number(e[1]) });
      open = null;
    }
  }
  // Een stilte die tot het eind duurt heeft geen silence_end; die telt als uitloop, niet als pauze.
  // De samenvatting van ebur128 staat onderaan; per-frame-regels hebben
  // dezelfde labels, dus de láátste treffer is de integrale waarde.
  const iAll = [...uit.matchAll(/\bI:\s+(-?[\d.]+) LUFS/g)];
  const lraAll = [...uit.matchAll(/\bLRA:\s+([\d.]+) LU\b/g)];
  const i = iAll.length ? Number(iAll[iAll.length - 1][1]) : null;
  const lra = lraAll.length ? Number(lraAll[lraAll.length - 1][1]) : null;
  return {
    stiltes,
    // -70 LUFS is ebur128's "niets gemeten" (geen of stil audiospoor).
    loudnessI: i !== null && Number.isFinite(i) && i > -69 ? i : null,
    loudnessLRA: lra !== null && Number.isFinite(lra) ? lra : null,
  };
}

/**
 * Puur: spraakstart, pauzes en tempo uit wat er is. Voorkeur woordtijden,
 * dan transcriptsegmenten, dan stiltedetectie.
 */
export function spraakMaten(inv: {
  woorden: Woord[] | null;
  segmenten: { start: number; end: number; tekst: string }[] | null;
  audio: Pick<AudioMeting, 'stiltes'>;
  duur: number;
}): { spraakStartS: number | null; pauzes: number[]; pauzeBron: 'woorden' | 'stilte'; woordenPerS: number | null } {
  const { woorden, segmenten, audio, duur } = inv;

  if (woorden && woorden.length > 0) {
    const w = [...woorden].sort((a, b) => a.start - b.start);
    const pauzes: number[] = [];
    for (let i = 1; i < w.length; i++) {
      const gat = w[i].start - w[i - 1].end;
      if (gat > PAUZE_MIN_S) pauzes.push(gat);
    }
    const spreektijd = w[w.length - 1].end - w[0].start;
    return {
      spraakStartS: w[0].start,
      pauzes,
      pauzeBron: 'woorden',
      woordenPerS: spreektijd > 1 ? w.length / spreektijd : null,
    };
  }

  // Stiltes: een stilte vanaf 0 is de aanloop vóór de eerste klank, geen pauze.
  const openingsStilte = audio.stiltes.find((s) => s.start < 0.05);
  const pauzes = audio.stiltes.filter((s) => s !== openingsStilte).map((s) => s.eind - s.start);

  // Geen openingsstilte = er klinkt meteen iets. Met muziek onder de intro
  // is dat niet per se spraak; het transcript hieronder corrigeert dat waar het kan.
  let spraakStartS: number | null = openingsStilte ? openingsStilte.eind : 0;
  let woordenPerS: number | null = null;
  const bruikbaar = (segmenten ?? []).filter((s) => s.tekst.trim().length > 0 && s.end > s.start);
  if (bruikbaar.length > 0) {
    spraakStartS = bruikbaar[0].start;
    const aantal = bruikbaar.reduce((a, s) => a + s.tekst.trim().split(/\s+/).length, 0);
    // Tempo over de tijd dat er gesproken wordt (som van de segmenten), niet
    // over de hele clip: een clip met muziekintro praat niet langzamer.
    const spreektijd = bruikbaar.reduce((a, s) => a + (s.end - s.start), 0);
    woordenPerS = spreektijd > 1 && aantal >= 3 ? aantal / spreektijd : null;
    // Buiten 1–6 woorden/s is het geen spraak maar een transcriptieartefact:
    // whisper "hoort" tekst in muziek, of plakt lange stiltes aan een
    // segment (gezien: 0,04 w/s op een clip van tien minuten). Liever geen
    // tempo dan een fout tempo in de normen.
    if (woordenPerS !== null && (woordenPerS < 1 || woordenPerS > 6)) woordenPerS = null;
  }
  if (spraakStartS !== null && spraakStartS > duur) spraakStartS = null;
  return { spraakStartS, pauzes, pauzeBron: 'stilte', woordenPerS };
}

/* ---------------------------------------------------------------- visueel */

const frameSchema = z.object({
  frames: z
    .array(
      z.object({
        index: z.number().int().describe('Volgnummer van het frame, beginnend bij 0, in de volgorde van de lijst.'),
        tekst_in_beeld: z.boolean().describe('Staat er leesbare tekst over het beeld (ondertitel, hooktekst, label)?'),
        soort: z.enum(['ondertitel', 'hooktekst', 'label', 'geen']),
        kader: z.enum(['close', 'medium', 'wijd', 'graphic', 'split']),
      }),
    )
    .describe('Precies één item per frame, in dezelfde volgorde.'),
  ondertitelstijl: z
    .enum(['woord-voor-woord', 'zin', 'geen'])
    .describe('Woord-voor-woord = 1-3 woorden tegelijk, vaak met markering; zin = een hele regel tegelijk.'),
  ondertitel_positie: z.enum(['boven', 'midden', 'onder', 'geen']),
  beweging_zoom_zichtbaar: z.boolean().describe('Is er tussen de frames een zichtbare zoom, punch-in of camerabeweging?'),
  broll: z.boolean().describe('Is er beeld dat niet de spreker/hoofdscène is (b-roll, screenshots, stockbeeld)?'),
  eerste_frame_hook: z.string().max(200).describe('Wat de kijker in frame 0 ziet, in één feitelijke zin.'),
});

const VISUEEL_SYSTEM = `Je meet montagekenmerken van een short-form clip op basis van stilstaande frames. Je bent een meetinstrument, geen recensent: beschrijf alleen wat letterlijk in elk frame staat.

- tekst_in_beeld: alleen tekst die over het beeld is gelegd (ondertitel, hooktekst, label, sticker met tekst). Tekst die in de scène zelf staat (een shirt, een bord op de achtergrond) telt niet.
- soort: ondertitel = uitgesproken woorden; hooktekst = een kop/vraag/claim die blijft staan; label = naam, bron of klein bijschrift.
- kader: close = hoofd/schouders vult het beeld; medium = tot middel; wijd = hele persoon of ruimte; graphic = volledig grafisch/tekstkaart/screenshot; split = twee beelden naast/boven elkaar.
- Twijfel je, kies het meest letterlijke antwoord.`;

/**
 * ~8 frames: de hook dicht bemonsterd (daar valt de kijkbeslissing), de rest
 * verspreid. Puur, voor de test.
 */
export function frameTijden(duur: number): number[] {
  const hook = [0.05, 0.6, 1.3, 2.2, 3.2].filter((t) => t < duur - 0.1);
  const rest: number[] = [];
  const van = 4;
  const tot = duur - 0.3;
  if (tot > van) {
    const aantal = 3;
    for (let i = 0; i < aantal; i++) rest.push(van + ((tot - van) / (aantal - 1 || 1)) * i);
  }
  return [...hook, ...rest].map((t) => rond(t, 2));
}

async function meetVisueel(pad: string, duur: number): Promise<VisueleVingerafdruk> {
  const map = await mkdtemp(join(tmpdir(), 'clipper-vinger-'));
  try {
    const tijden = frameTijden(duur);
    const beelden: { pad: string; seconde: number }[] = [];
    let eersteFout: string | null = null;
    for (const [i, t] of tijden.entries()) {
      const uit = join(map, `f${String(i).padStart(2, '0')}.jpg`);
      try {
        await runStil(resolveBinary('ffmpeg'), [
          '-nostdin', '-y', '-ss', t.toFixed(2), '-i', pad, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', uit,
        ]);
        beelden.push({ pad: uit, seconde: t });
      } catch (e) {
        eersteFout ??= (e as Error).message.slice(0, 200);
      }
    }
    if (beelden.length < 3) throw new Error(`te weinig frames (${beelden.length}): ${eersteFout ?? 'onbekend'}`);

    const r = await structuredCall({
      system: VISUEEL_SYSTEM,
      user: `Clip van ${rond(duur, 1)} seconden. De frames, in volgorde:\n${beelden
        .map((b, i) => `- frame ${i}: seconde ${b.seconde.toFixed(1)}`)
        .join('\n')}`,
      schema: frameSchema,
      toolName: 'lever_meting',
      toolDescription: 'Lever de meting per frame en de kenmerken van de hele clip.',
      maxTokens: 3000,
      effort: 'low',
      operation: 'vingerafdruk_visueel',
      model: CLAUDE_LICHT_MODEL,
      beeldPaden: beelden.map((b) => b.pad),
    });

    const frames = beelden.map((b, i) => {
      const f = r.frames.find((x) => x.index === i) ?? r.frames[i];
      return {
        seconde: b.seconde,
        tekst_in_beeld: f?.tekst_in_beeld ?? false,
        soort: (f?.tekst_in_beeld ? f.soort : 'geen') as TekstSoort,
        kader: (f?.kader ?? 'medium') as Kader,
      };
    });
    const tekst = tekstMaten(frames, duur);
    return {
      frames,
      ondertitelstijl: r.ondertitelstijl,
      ondertitel_positie: r.ondertitel_positie,
      kader: meestVoorkomend(frames.map((f) => f.kader)) ?? 'medium',
      beweging_zoom_zichtbaar: r.beweging_zoom_zichtbaar,
      broll: r.broll,
      eerste_frame_hook: r.eerste_frame_hook,
      tekstInBeeldAandeel: rond(tekst.aandeel, 3),
      langsteZonderTekstS: rond(tekst.langsteZonder, 2),
      tekstInEersteFrame: frames[0]?.tekst_in_beeld ?? false,
    };
  } finally {
    await rm(map, { recursive: true, force: true });
  }
}

/**
 * Puur: van losse frames naar tijd. Elk frame "bezit" de tijd tot halverwege
 * zijn buren; zo weegt de dicht bemonsterde hook niet zwaarder dan hij in de
 * clip duurt. De langste tekstloze periode is een schatting — tussen twee
 * frames kan tekst verschijnen die we niet zien.
 */
export function tekstMaten(frames: { seconde: number; tekst_in_beeld: boolean }[], duur: number): { aandeel: number; langsteZonder: number } {
  const f = [...frames].sort((a, b) => a.seconde - b.seconde);
  if (f.length === 0 || duur <= 0) return { aandeel: 0, langsteZonder: duur };
  const grens = (i: number) => (i <= 0 ? 0 : i >= f.length ? duur : (f[i - 1].seconde + f[i].seconde) / 2);
  let metTekst = 0;
  let langste = 0;
  let loopStart: number | null = null;
  for (let i = 0; i < f.length; i++) {
    const van = grens(i);
    const tot = grens(i + 1);
    if (f[i].tekst_in_beeld) {
      metTekst += tot - van;
      if (loopStart !== null) langste = Math.max(langste, van - loopStart);
      loopStart = null;
    } else if (loopStart === null) {
      loopStart = van;
    }
  }
  if (loopStart !== null) langste = Math.max(langste, duur - loopStart);
  return { aandeel: Math.min(1, metTekst / duur), langsteZonder: langste };
}

/* ------------------------------------------------------------------ hulp */

function meestVoorkomend<T>(waarden: T[]): T | null {
  const tel = new Map<T, number>();
  for (const w of waarden) tel.set(w, (tel.get(w) ?? 0) + 1);
  let beste: T | null = null;
  let n = 0;
  for (const [w, c] of tel) if (c > n) [beste, n] = [w, c];
  return beste;
}

function mediaanVan(xs: number[]): number | null {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function rond(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** ffmpeg-meetfilters schrijven naar stderr (metadata=print:file=- naar stdout). */
function ffmpegStderr(args: string[], ookStdout = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const kind = spawn(resolveBinary('ffmpeg'), args, { stdio: ['ignore', ookStdout ? 'pipe' : 'ignore', 'pipe'] });
    let err = '';
    let out = '';
    kind.stdout?.on('data', (d) => (out += d));
    kind.stderr?.on('data', (d) => (err += d));
    kind.on('error', reject);
    kind.on('close', (code) => {
      // Zonder audiospoor faalt de audiopas met "matches no streams": dat is
      // een clip zonder geluid, geen kapotte meting.
      if (code !== 0 && /matches no streams|does not contain any stream/i.test(err)) return resolve('');
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`));
      resolve(ookStdout ? out : err);
    });
  });
}

function runStil(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const kind = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    kind.stderr.on('data', (d) => (err += d));
    kind.on('error', reject);
    kind.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exit ${code}: ${err.slice(-200)}`))));
  });
}
