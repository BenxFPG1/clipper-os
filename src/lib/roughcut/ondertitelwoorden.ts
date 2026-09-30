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
      if (code !== 0) return fout(new Error(`align.py exit ${code}: ${stderr.slice(-160)}`));
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
      woord: z.string().describe('Het juiste woord, precies één woord (koppelteken mag), zonder spaties.'),
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
};

const kaal = (w: string) => w.replace(/[.,!?;:"'“”„()]+$/g, '').replace(/^["'“„(]+/, '');

/**
 * Past correcties toe, streng: één woord voor één woord, geen getallen
 * wijzigen, geen herschrijvingen (lengte blijft in de buurt), leestekens van
 * het origineel blijven staan. Tijden blijven exact.
 */
export function pasCorrectiesToe(woorden: BronWoord[], correcties: Correctie[]): { woorden: BronWoord[]; toegepast: { van: string; naar: string }[] } {
  const uit = woorden.map((w) => ({ ...w }));
  const toegepast: { van: string; naar: string }[] = [];
  const gezien = new Set<number>();
  for (const c of correcties) {
    if (gezien.has(c.index) || c.index < 0 || c.index >= uit.length) continue;
    gezien.add(c.index);
    const oud = uit[c.index].w;
    const nieuwKaal = kaal(c.woord.trim());
    const oudKaal = kaal(oud);
    if (!nieuwKaal || /\s/.test(nieuwKaal) || nieuwKaal.length > 40) continue;
    if (nieuwKaal.toLowerCase() === oudKaal.toLowerCase()) continue;
    // Getallen blijven van de spreker: een "correctie" van 2920 naar 2.920
    // of van 39 naar 90 is geen herkenningsfout maar een wijziging.
    if (/\d/.test(oudKaal) || /\d/.test(nieuwKaal)) continue;
    const verhouding = nieuwKaal.length / Math.max(1, oudKaal.length);
    if (verhouding > 3 || verhouding < 0.34) continue;
    const voor = oud.match(/^["'“„(]+/)?.[0] ?? '';
    const na = oud.match(/[.,!?;:"'“”„()]+$/)?.[0] ?? '';
    uit[c.index].w = `${voor}${nieuwKaal}${na}`;
    toegepast.push({ van: oudKaal, naar: nieuwKaal });
  }
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

/**
 * Eén call per clip met het lichte model. De woorden gaan er genummerd in,
 * de correcties komen terug als {index, woord}; toegepast met
 * pasCorrectiesToe. Faalt de call, dan gaan de woorden ongecorrigeerd door.
 */
export async function corrigeerWoorden(
  woorden: BronWoord[],
  context: CorrectieContext,
  call: CorrectieCall = standaardCall,
): Promise<{ woorden: BronWoord[]; toegepast: { van: string; naar: string }[]; fout?: string }> {
  if (woorden.length === 0) return { woorden, toegepast: [] };
  const system = `Je controleert automatische ondertitels (spraakherkenning, Nederlands) op herkenningsfouten. Je krijgt de woorden genummerd, plus context over de video.

Corrigeer ALLEEN duidelijke herkenningsfouten: een woord dat zo niet gezegd kan zijn en waarvan uit de context vaststaat wat het wel was ("enimetaal" → "edelmetaal", een verkeerd geschreven eigennaam die in de context staat). Eén woord voor één woord. Staan er ondertitels van de video zelf bij, dan zijn die leidend voor de spelling van namen, bijnamen en straattaal.

Niet doen: herschrijven, stijl of grammatica verbeteren, woorden toevoegen of weglaten, spreektaal netjes maken, getallen veranderen. Twijfel je, dan laat je het staan. Geen fout gevonden: een lege lijst.`;
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
${woorden.map((w, i) => `${i}:${w.w}`).join(' ')}`;
  try {
    const r = await call(system, user);
    const { woorden: uit, toegepast } = pasCorrectiesToe(woorden, r.correcties ?? []);
    return { woorden: uit, toegepast };
  } catch (e) {
    return { woorden, toegepast: [], fout: (e as Error).message.slice(0, 100) };
  }
}
