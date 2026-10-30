import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { structuredCall } from '../claude';
import { CLAUDE_LICHT_MODEL } from '../env';
import { resolveBinary } from '../ingest/binaries';
import { r2Download, r2Upload } from '../r2';
import { instelling } from './instellingen';
import { sectiePlan } from './renderbron';
import type { BronWoord } from './woorden';

/**
 * De woorden voor de ondertitels: beter dan de hele-video-transcriptie.
 *
 * De brontranscriptie van de hele video draait op faster-whisper 'small' —
 * goed genoeg voor tijden (poort, snap, retentie), maar niet voor tekst die
 * de kijker leest: "enimetaal" voor "edelmetaal", "platen naar" voor
 * "platina". Twee lagen:
 *
 *  1. Alleen de stukken die de clip gebruikt opnieuw transcriberen met een
 *     groter model (standaard large-v3-turbo, int8 op de CPU), gecachet per
 *     bereik en model. Binnen een tijdsbudget; wat niet lukt, houdt 'small'.
 *  2. Een correctiepas met het lichte model: alleen duidelijke
 *     herkenningsfouten, woord voor woord, met de context van de clip (titel,
 *     campagne, namen, scriptfragmenten). Tijden blijven exact staan.
 */

// ------------------------------------------------------------------ laag 1: groter model per bereik

export type Transcribeer = (wav: string, model: string, timeoutMs: number) => Promise<BronWoord[]>;
export type WoordCache = { lees: (sleutel: string) => Promise<BronWoord[] | null>; schrijf: (sleutel: string, w: BronWoord[]) => Promise<void> };

/** De echte transcriptie: scripts/align.py (faster-whisper), met een harde time-out. */
export const transcribeerViaAlign: Transcribeer = (wav, model, timeoutMs) =>
  new Promise((klaar, fout) => {
    const [cmd, voor] = process.platform === 'darwin' ? ['arch', ['-arm64', 'python3']] : ['python3', []];
    const kind = spawn(cmd, [...voor, 'scripts/align.py', wav, model], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      kind.kill('SIGKILL');
      fout(new Error(`time-out na ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    kind.stdout.on('data', (d) => (stdout += d));
    kind.stderr.on('data', (d) => (stderr += d));
    kind.on('error', (e) => {
      clearTimeout(timer);
      fout(e);
    });
    kind.on('close', (code) => {
      clearTimeout(timer);
      // De laatste regel van een Python-traceback is de eigenlijke fout; de
      // staart van stderr was een rij ^^^^ en een halve bestandsnaam.
      const laatste = stderr.trim().split('\n').filter((r) => r.trim() && !/^\s*\^+\s*$/.test(r)).pop() ?? '';
      if (code !== 0) return fout(new Error(`align.py exit ${code}: ${laatste.trim().slice(0, 200)}`));
      try {
        klaar(JSON.parse(stdout.trim().split('\n').pop() ?? '[]') as BronWoord[]);
      } catch (e) {
        fout(e as Error);
      }
    });
  });

export const r2WoordCache: WoordCache = {
  lees: async (sleutel) => {
    const dl = await r2Download(sleutel);
    if (!dl.data) return null;
    try {
      const w = JSON.parse(await dl.data.text()) as BronWoord[];
      return w.length > 0 ? w : null;
    } catch {
      return null;
    }
  },
  schrijf: async (sleutel, w) => {
    await r2Upload(sleutel, Buffer.from(JSON.stringify(w)), 'application/json');
  },
};

function knipAudio(bron: string, van: number, tot: number, wav: string): Promise<void> {
  return new Promise((klaar, fout) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      ['-nostdin', '-y', '-ss', van.toFixed(3), '-t', (tot - van).toFixed(3), '-i', bron, '-vn', '-ac', '1', '-ar', '16000', wav],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    kind.stderr.on('data', (d) => (stderr += d));
    kind.on('error', fout);
    kind.on('close', (code) => (code === 0 ? klaar() : fout(new Error(stderr.slice(-120)))));
  });
}

export type VerfijnResultaat = {
  woorden: BronWoord[];
  bereiken: { van: number; tot: number; bron: 'cache' | 'nieuw' | 'terugval'; model: string; reden?: string }[];
  ms: number;
  audioSeconden: number;
};

/**
 * De ondertitelwoorden voor één clip: binnen de gebruikte bereiken uit het
 * grotere model (cache of nieuw), daarbuiten de hele-video-woorden. Binnen
 * een bereik worden de randen (een halve seconde) niet vertrouwd — daar
 * breekt het model woorden af — en blijven de oude woorden staan.
 */
export async function verfijnWoorden(opties: {
  videoId: string;
  bronPad: string;
  segmenten: { start: number; end: number }[];
  bronWoorden: BronWoord[];
  model?: string;
  budgetSeconden?: number;
  transcribeer?: Transcribeer;
  cache?: WoordCache;
  log?: (m: string) => void;
}): Promise<VerfijnResultaat> {
  const begin = Date.now();
  const model = opties.model ?? process.env.WHISPER_ONDERTITEL_MODEL ?? 'large-v3-turbo';
  const budget = (opties.budgetSeconden ?? instelling('ONDERTITEL_MODEL_BUDGET')) * 1000;
  const transcribeer = opties.transcribeer ?? transcribeerViaAlign;
  const cache = opties.cache ?? r2WoordCache;
  const bereiken = sectiePlan(opties.segmenten, { marge: 1, samenvoegGat: 5 });
  const resultaat: VerfijnResultaat['bereiken'] = [];
  const nieuw: BronWoord[][] = [];
  let audioSeconden = 0;

  const werkmap = await mkdtemp(join(tmpdir(), 'clipper-otw-'));
  try {
    for (const b of bereiken) {
      const sleutel = `woorden/${opties.videoId}-${model}-${b.van.toFixed(1)}-${b.tot.toFixed(1)}.json`;
      let woorden: BronWoord[] | null = null;
      try {
        woorden = await cache.lees(sleutel);
      } catch {
        woorden = null;
      }
      if (woorden) {
        resultaat.push({ ...b, bron: 'cache', model });
        nieuw.push(woorden);
        continue;
      }
      const over = budget - (Date.now() - begin);
      if (over < 5000) {
        resultaat.push({ ...b, bron: 'terugval', model: 'small', reden: 'tijdsbudget op' });
        nieuw.push([]);
        continue;
      }
      try {
        const wav = join(werkmap, `b-${b.van.toFixed(1)}.wav`);
        await knipAudio(opties.bronPad, b.van, b.tot, wav);
        const ruw = await transcribeer(wav, model, over);
        const op = ruw.map((w) => ({ w: w.w, s: Math.round((w.s + b.van) * 1000) / 1000, e: Math.round((w.e + b.van) * 1000) / 1000 }));
        audioSeconden += b.tot - b.van;
        if (op.length === 0) throw new Error('geen woorden');
        try {
          await cache.schrijf(sleutel, op);
        } catch {
          // niet fataal: volgende render transcribeert opnieuw
        }
        resultaat.push({ ...b, bron: 'nieuw', model });
        nieuw.push(op);
      } catch (e) {
        resultaat.push({ ...b, bron: 'terugval', model: 'small', reden: (e as Error).message.slice(0, 80) });
        nieuw.push([]);
      }
    }
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }

  // Samenvoegen: binnen elk verfijnd bereik (minus een halve seconde rand) de
  // nieuwe woorden, daarbuiten de oude.
  const rand = 0.5;
  const binnen = (t: number) =>
    resultaat.findIndex((r, i) => r.bron !== 'terugval' && nieuw[i].length > 0 && t >= r.van + rand && t < r.tot - rand);
  const uit: BronWoord[] = opties.bronWoorden.filter((w) => binnen((w.s + w.e) / 2) < 0);
  resultaat.forEach((r, i) => {
    if (r.bron === 'terugval') return;
    for (const w of nieuw[i]) {
      const m = (w.s + w.e) / 2;
      if (m >= r.van + rand && m < r.tot - rand) uit.push(w);
    }
  });
  uit.sort((a, b) => a.s - b.s);
  return { woorden: uit, bereiken: resultaat, ms: Date.now() - begin, audioSeconden };
}

// ------------------------------------------------------------------ laag 2: correctiepas

export type Correctie = { index: number; woord: string };

const correctieSchema = z.object({
  correcties: z.array(
    z.object({
      index: z.number().int().min(0),
      woord: z.string().describe('Het juiste woord; hoogstens drie woorden als de herkenning twee woorden aan elkaar plakte ("duurtraloesje" → "duurste horloge").'),
    }),
  ),
});

export type CorrectieContext = {
  titel?: string | null;
  campagne?: string | null;
  namen?: string[];
  verhaallijn?: string | null;
  fragmenten?: string[];
  /**
   * De YouTube-captions (of een handmatig transcript) van hetzelfde bereik:
   * vaak geschreven door de maker zelf, en dan kennen ze de namen en de
   * straattaal die Whisper verhaspelt ("Skaard-japtom").
   */
  captions?: string | null;
  /**
   * Per woord (zelfde index) wat de tweede, onafhankelijke herkenning (de
   * hele-video-transcriptie, 'small') op hetzelfde moment hoorde; null als
   * daar niets lag. Zie tweedeLezing.
   */
  tweede?: (string | null)[];
};

/** Korte woorden die bijna hetzelfde klinken en die de modellen door elkaar halen. */
const VERWARBAAR = new Set(['en', 'een', 'de', 'het', 'op', 'of', 'dat', 'wat', 'die', 'dit', 'is', 'in']);

/**
 * Wat de tweede herkenning hoorde op het moment van elk woord: het
 * bronwoord met de meeste overlap in tijd, of null.
 */
export function tweedeLezing(woorden: BronWoord[], bron: BronWoord[]): (string | null)[] {
  return woorden.map((w) => {
    let beste: BronWoord | null = null;
    let besteOverlap = 0;
    for (const b of bron) {
      if (b.e <= w.s || b.s >= w.e) continue;
      const o = Math.min(b.e, w.e) - Math.max(b.s, w.s);
      if (o > besteOverlap) (beste = b), (besteOverlap = o);
    }
    return beste ? kaal(beste.w) : null;
  });
}

function afstand(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let vorige = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, vorige + (a[i - 1] === b[j - 1] ? 0 : 1));
      vorige = t;
    }
  }
  return d[b.length];
}

/** Alle woorden waarmee een correctie onderbouwd kan worden, in kleine letters. */
function contextWoorden(c: CorrectieContext): Set<string> {
  const tekst = [c.titel, c.campagne, ...(c.namen ?? []), c.verhaallijn, ...(c.fragmenten ?? []), c.captions].filter(Boolean).join(' ');
  return new Set(tekst.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

const kaal = (w: string) => w.replace(/[.,!?;:"'“”„()]+$/g, '').replace(/^["'“„(]+/, '');

/**
 * Past correcties toe, streng: één woord voor één woord, geen getallen
 * wijzigen, geen herschrijvingen (lengte blijft in de buurt), leestekens van
 * het origineel blijven staan. Tijden blijven exact.
 */
export function pasCorrectiesToe(
  woorden: BronWoord[],
  correcties: Correctie[],
  context: CorrectieContext = {},
): { woorden: BronWoord[]; toegepast: { van: string; naar: string }[]; afgewezen: { van: string; naar: string; waarom: string }[] } {
  const uit = woorden.map((w) => ({ ...w }));
  const toegepast: { van: string; naar: string }[] = [];
  const afgewezen: { van: string; naar: string; waarom: string }[] = [];
  const gezien = new Set<number>();
  for (const c of correcties) {
    if (gezien.has(c.index) || c.index < 0 || c.index >= uit.length) continue;
    gezien.add(c.index);
    const oud = uit[c.index].w;
    // Hoogstens drie woorden: soms is één herkenningsfout eigenlijk twee
    // woorden ("duurtraloesje" → "duurste horloge"). De tijd wordt later
    // over de delen verdeeld (woordenOpTijdlijn).
    const nieuwKaal = c.woord.trim().split(/\s+/).map(kaal).filter(Boolean).join(' ');
    const oudKaal = kaal(oud);
    const weg = (waarom: string) => afgewezen.push({ van: oudKaal, naar: nieuwKaal, waarom });
    if (!nieuwKaal || nieuwKaal.split(' ').length > 3 || nieuwKaal.length > 40) {
      weg('meer dan drie woorden of te lang');
      continue;
    }
    if (nieuwKaal.toLowerCase() === oudKaal.toLowerCase()) continue;
    // Getallen blijven van de spreker: een "correctie" van 2920 naar 2.920
    // of van 39 naar 90 is geen herkenningsfout maar een wijziging.
    if (/\d/.test(oudKaal) || /\d/.test(nieuwKaal)) {
      weg('getal');
      continue;
    }
    const verhouding = nieuwKaal.replace(/ /g, '').length / Math.max(1, oudKaal.length);
    if (verhouding > 3 || verhouding < 0.34) {
      weg('lengte wijkt te veel af');
      continue;
    }
    // Een spellingsgok: een lang woord dat maar een letter of twee verandert
    // ("volatiler" → "volatider") terwijl de context of de tweede herkenning
    // het oude woord bevestigt en het nieuwe nergens voorkomt, is geen
    // herkenningsfout maar het model dat gaat spellen.
    const nieuwKlein = nieuwKaal.toLowerCase();
    const oudKlein = oudKaal.toLowerCase();
    const gesteund = (w: string) => contextWoorden(context).has(w) || context.tweede?.[c.index]?.toLowerCase() === w;
    if (!nieuwKaal.includes(' ') && oudKaal.length >= 6 && afstand(oudKlein, nieuwKlein) <= 2 && gesteund(oudKlein) && !gesteund(nieuwKlein)) {
      weg('spellingsgok zonder bron');
      continue;
    }
    const voor = oud.match(/^["'“„(]+/)?.[0] ?? '';
    const na = oud.match(/[.,!?;:"'“”„()]+$/)?.[0] ?? '';
    uit[c.index].w = `${voor}${nieuwKaal}${na}`;
    toegepast.push({ van: oudKaal, naar: nieuwKaal });
  }
  return { woorden: uit, toegepast, afgewezen };
}

/**
 * Namen uit de character map, vast gespeld: een woord met een hoofdletter
 * midden in de zin dat er maar een letter of twee van afwijkt, is die naam
 * ("Arshi" → "Archi"). Het taalmodel liet dit in MUKBANG staan omdat het
 * "Archie" verwachtte.
 */
export function naamSpelling(woorden: BronWoord[], namen: string[]): { woorden: BronWoord[]; toegepast: { van: string; naar: string }[] } {
  const delen = [...new Set(namen.flatMap((n) => n.split(/\s+/)).filter((n) => n.length >= 4))];
  const toegepast: { van: string; naar: string }[] = [];
  const uit = woorden.map((w, i) => {
    const k = kaal(w.w);
    const eersteVanZin = i === 0 || /[.!?…]["'”)]*$/.test(woorden[i - 1].w);
    if (eersteVanZin || k.length < 4 || !/^\p{Lu}/u.test(k)) return w;
    const naam = delen.find((n) => n !== k && n[0].toLowerCase() === k[0].toLowerCase() && afstand(n.toLowerCase(), k.toLowerCase()) <= 2);
    if (!naam) return w;
    toegepast.push({ van: k, naar: naam });
    return { ...w, w: w.w.replace(k, naam) };
  });
  return { woorden: uit, toegepast };
}

export type CorrectieCall = (system: string, user: string) => Promise<{ correcties: Correctie[] }>;

const standaardCall: CorrectieCall = (system, user) =>
  structuredCall({
    system,
    user,
    schema: correctieSchema,
    toolName: 'lever_ondertitelcorrecties',
    toolDescription: 'Lever alleen de duidelijke herkenningsfouten, per woordindex.',
    maxTokens: 3000,
    effort: 'low',
    operation: 'ondertitel_correctie',
    model: CLAUDE_LICHT_MODEL,
  });

export type KeuzeCall = (system: string, user: string) => Promise<{ keuzes: Correctie[] }>;

const keuzeSchema = z.object({
  keuzes: z.array(z.object({ index: z.number().int().min(0), woord: z.string().describe('Een van de twee woorden tussen de haken.') })),
});

const standaardKeuze: KeuzeCall = (system, user) =>
  structuredCall({
    system,
    user,
    schema: keuzeSchema,
    toolName: 'lever_keuzes',
    toolDescription: 'Lever per plek (index) het woord dat de spreker zei: een van de twee tussen de haken.',
    maxTokens: 800,
    effort: 'low',
    operation: 'ondertitel_keuze',
    model: CLAUDE_LICHT_MODEL,
  });

/**
 * Eén call per clip met het lichte model. De woorden gaan er genummerd in,
 * de correcties komen terug als {index, woord}; toegepast met
 * pasCorrectiesToe. Faalt de call, dan gaan de woorden ongecorrigeerd door.
 */
export async function corrigeerWoorden(
  woorden: BronWoord[],
  context: CorrectieContext,
  call: CorrectieCall = standaardCall,
  kies: KeuzeCall = standaardKeuze,
): Promise<{ woorden: BronWoord[]; toegepast: { van: string; naar: string }[]; afgewezen?: { van: string; naar: string; waarom: string }[]; voorgesteld?: number; fout?: string }> {
  if (woorden.length === 0) return { woorden, toegepast: [] };
  const system = `Je controleert automatische ondertitels (spraakherkenning, Nederlands) op herkenningsfouten. Je krijgt de woorden genummerd, plus context over de video.

Corrigeer ALLEEN duidelijke herkenningsfouten: een woord dat zo niet gezegd kan zijn en waarvan uit de context vaststaat wat het wel was ("enimetaal" → "edelmetaal", een verkeerd geschreven eigennaam die in de context staat). Eén woord voor één woord; alleen als de herkenning twee woorden aan elkaar plakte mag het er twee of drie worden ("duurtraloesje" → "duurste horloge"). Staan er ondertitels van de video zelf bij, dan zijn die leidend voor de spelling van namen, bijnamen en straattaal — tenzij ze zelf duidelijk automatisch en verhaspeld zijn; dan geldt de context.

Let ook op korte woorden die bijna hetzelfde klinken: "En"/"Een", "de"/"een", "op"/"of", "dat"/"wat". Aan het begin van een zin na een punt is "Een aanbod dat…" bijna altijd "En aanbod dat…". De scriptfragmenten komen uit een tweede, onafhankelijke herkenning van dezelfde audio: wijkt een kort woord daarvan af, kies dan de variant die in de zin klopt (grammatica en betekenis) — het fragment is niet altijd juist ("Goud beweegt of vertrouwen" moet "op vertrouwen" zijn).

Woorden met "≠" erachter: daar hoorde de tweede herkenning iets anders ("12:een≠de" = dit model hoorde "een", het andere "de"). Kies op die plekken ALTIJD expliciet: lever voor elk zo'n index een correctie met het woord dat in de zin klopt — ook als dat het huidige woord is. Een lidwoord dat naar iets bekends verwijst ("En de prijs die nog ver onder zijn record staat") is "de", niet "een".

Niet doen: herschrijven, stijl of grammatica verbeteren, woorden toevoegen of weglaten, spreektaal netjes maken, getallen veranderen. Twijfel je, dan laat je het staan. Geen fout gevonden: een lege lijst.`;
  // Alleen korte, verwarbare woorden markeren: bij lange woorden is het
  // grote model vrijwel altijd beter en zou een markering alleen ruis zijn.
  const twijfel = (i: number) => {
    const a = kaal(woorden[i].w).toLowerCase();
    const b = context.tweede?.[i]?.toLowerCase();
    return !!b && a !== b && VERWARBAAR.has(a) && VERWARBAAR.has(b);
  };
  const regels = [
    context.titel ? `Video: ${context.titel}` : null,
    context.campagne ? `Campagne/merk: ${context.campagne}` : null,
    context.namen?.length ? `Namen in de video: ${context.namen.join(', ')}` : null,
    context.verhaallijn ? `Waar de clip over gaat: ${context.verhaallijn}` : null,
    context.fragmenten?.length ? `Scriptfragmenten (bedoelde tekst, kan afwijken):\n${context.fragmenten.map((f) => `- ${f}`).join('\n')}` : null,
    context.captions ? `Ondertitels van de video zelf voor dit stuk (YouTube/maker; spelling van namen en straattaal is hier meestal juist, tijden niet):\n${context.captions.slice(0, 4000)}` : null,
  ].filter(Boolean);
  const user = `${regels.join('\n')}

Ondertitelwoorden (index:woord):
${woorden.map((w, i) => `${i}:${w.w}${twijfel(i) ? `≠${context.tweede![i]}` : ''}`).join(' ')}`;
  try {
    const r = await call(system, user);
    // Twijfelplekken: altijd één gerichte vraag per plek ("En [een | de]
    // prijs die nog ver onder…"), en die beslist. In trainingsronde 10 koos de
    // brede pas "de", in ronde 12 bij exact dezelfde audio "een" — een keuze
    // tussen veertig andere woorden is een gok. Deze vraag is klein en kan
    // maar twee antwoorden hebben.
    const open = woorden.map((_, i) => i).filter((i) => twijfel(i));
    const correcties = (r.correcties ?? []).filter((c) => !open.includes(c.index));
    // "aan het kijken" is vaste grammatica: "aan een kijken" bestaat niet. Dat
    // hoeft niemand te raden (MUKBANG ronde 3: de keuzevraag koos "een").
    for (const i of [...open]) {
      const voor = kaal(woorden[i - 1]?.w ?? '').toLowerCase();
      const na = kaal(woorden[i + 1]?.w ?? '').toLowerCase();
      const opties = [kaal(woorden[i].w).toLowerCase(), context.tweede![i]!.toLowerCase()];
      if (voor === 'aan' && /\p{L}{2,}en$/u.test(na) && opties.includes('het')) {
        correcties.push({ index: i, woord: 'het' });
        open.splice(open.indexOf(i), 1);
      }
    }
    if (open.length > 0) {
      const zin = (i: number) =>
        woorden
          .slice(Math.max(0, i - 6), i + 8)
          .map((w, k) => (Math.max(0, i - 6) + k === i ? `[${kaal(w.w)} | ${context.tweede![i]}]` : w.w))
          .join(' ');
      const k = await kies(
        'Je kiest per plek welk van twee bijna gelijk klinkende woorden de spreker zei. Kies het woord dat grammaticaal en inhoudelijk in de zin past; bij een lidwoord dat naar iets bepaalds verwijst ("de prijs die nog ver onder zijn record staat") is het "de".',
        open.map((i) => `${i}: ${zin(i)}`).join('\n'),
      ).catch(() => ({ keuzes: [] as Correctie[] }));
      for (const c of k.keuzes ?? []) {
        if (!open.includes(c.index)) continue;
        const opties = [kaal(woorden[c.index].w).toLowerCase(), context.tweede![c.index]!.toLowerCase()];
        if (opties.includes(kaal(c.woord).toLowerCase())) correcties.push(c);
      }
    }
    const { woorden: uit, toegepast, afgewezen } = pasCorrectiesToe(woorden, correcties, context);
    const namen = naamSpelling(uit, context.namen ?? []);
    return { woorden: namen.woorden, toegepast: [...toegepast, ...namen.toegepast], afgewezen, voorgesteld: correcties.length };
  } catch (e) {
    return { woorden, toegepast: [], fout: (e as Error).message.slice(0, 100) };
  }
}
