import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { structuredCall } from '../claude';
import { CLAUDE_LICHT_MODEL } from '../env';
import { resolveBinary } from '../ingest/binaries';
import { instelling } from './instellingen';
import type { Shot } from './index';
import type { Box } from './graphics';
import type { BronWoord } from './woorden';

/**
 * Gerichte beweging in een graphic.
 *
 * Een graphic die lang in beeld staat kreeg een gelijkmatige push-in, maar
 * die zoomde op het midden. Een editor volgt de spreker: noemt zij
 * "zeldzaam", dan gaat het beeld naar dat punt, bij "industrieel onmisbaar"
 * naar het volgende (PLATINA trainingsronde 3: negen seconden dezelfde
 * pagina met drie punten). Hier leest het lichte model de pagina (welke
 * tekstblokken staan waar), en de woordtijden zeggen wanneer elk blok
 * genoemd wordt. De render zoomt dan op die momenten naar dat blok.
 */

/** titel: de kop van de hele dia — geen zoompunt, maar moet in beeld blijven. */
export type GraphicItem = { tekst: string; box: Box; titel?: boolean };
/** Een zoompunt: op brontijd t richt het beeld op (cx, cy) in het volle bronbeeld, met de breedte en hoogte van het blok. */
export type FocusPunt = { t: number; cx: number; cy: number; b: number; h: number; titel?: { x0: number; y0: number; x1: number; y1: number } };

const itemSchema = z.object({
  items: z
    .array(
      z.object({
        tekst: z.string().describe('De tekst van het blok zoals hij in beeld staat (kop of label van één punt).'),
        x0: z.number().min(0).max(1),
        y0: z.number().min(0).max(1),
        x1: z.number().min(0).max(1),
        y1: z.number().min(0).max(1),
      }),
    )
    .max(8),
  titel: z
    .object({ tekst: z.string(), x0: z.number().min(0).max(1), y0: z.number().min(0).max(1), x1: z.number().min(0).max(1), y1: z.number().min(0).max(1) })
    .nullable()
    .describe('De titel/kop van de hele dia met zijn vak, of null als die er niet is.'),
});

/** Leest de tekstblokken (punten, kolommen, labels) van één graphic-frame. Leeg bij een fout. */
export async function leesGraphic(bronPad: string, seconde: number): Promise<GraphicItem[]> {
  const map = await mkdtemp(join(tmpdir(), 'clipper-graphic-'));
  try {
    const pad = join(map, 'graphic.jpg');
    if (!(await frame(bronPad, seconde, pad))) return [];
    const uit = await structuredCall({
      system:
        'Je leest een informatieve graphic uit een video (een dia met punten, kolommen of een grafiek). Geef de afzonderlijke inhoudsblokken die een spreker na elkaar zou noemen: per blok de tekst (de kop of het label) en het vak waarin het blok staat, als fracties van de beeldbreedte en -hoogte (0 = links/boven, 1 = rechts/onder). De titel van de hele dia hoort niet bij de blokken: die geef je apart als titel (met zijn vak). Geen logo, geen bronvermelding. Zijn er geen afzonderlijke blokken, geef dan een lege lijst.',
      user: 'Welke inhoudsblokken staan er op deze graphic, en waar?',
      schema: itemSchema,
      toolName: 'lever_graphicblokken',
      toolDescription: 'Lever de inhoudsblokken van de graphic met hun plek.',
      maxTokens: 1500,
      effort: 'low',
      operation: 'render_graphiclezer',
      beeldPaden: [pad],
      model: CLAUDE_LICHT_MODEL,
    });
    const t = uit.titel;
    return [
      ...uit.items
        .filter((i) => i.x1 > i.x0 && i.y1 > i.y0 && i.tekst.trim().length >= 2)
        .map((i) => ({ tekst: i.tekst.trim(), box: { x0: i.x0, y0: i.y0, x1: i.x1, y1: i.y1 } })),
      ...(t && t.x1 > t.x0 && t.y1 > t.y0 ? [{ tekst: t.tekst.trim(), box: { x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1 }, titel: true }] : []),
    ];
  } catch (e) {
    console.warn('[graphiclezer] overgeslagen:', (e as Error).message.slice(0, 120));
    return [];
  } finally {
    await rm(map, { recursive: true, force: true });
  }
}

const kaal = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Wanneer wordt elk blok genoemd? Het eerste woord tussen van en tot (bron-
 * tijd) dat met een inhoudswoord van het blok begint. Blokken die niet
 * genoemd worden vallen weg; de volgorde is die van de spraak.
 */
export function focusPunten(items: GraphicItem[], woorden: BronWoord[], van: number, tot: number): FocusPunt[] {
  const inBereik = woorden.filter((w) => w.s >= van - 0.05 && w.s < tot);
  const punten: FocusPunt[] = [];
  for (const item of items.filter((x) => !x.titel)) {
    const sleutels = item.tekst.split(/\s+/).map(kaal).filter((w) => w.length >= 4);
    if (sleutels.length === 0) continue;
    const w = inBereik.find((x) => {
      const k = kaal(x.w);
      return k.length >= 4 && sleutels.some((s) => k.startsWith(s.slice(0, 6)) || s.startsWith(k.slice(0, 6)));
    });
    if (!w) continue;
    const b = item.box;
    punten.push({ t: w.s, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, b: b.x1 - b.x0, h: b.y1 - b.y0 });
  }
  return punten.sort((a, b) => a.t - b.t);
}

/**
 * Leest de graphics die lang genoeg in beeld staan en zet hun zoompunten op
 * de scènes (scene.focus). Aaneengesloten graphic-stukken — gesplitst op een
 * opbouwstap of over een kaderwissel heen in twee shots — zijn één pagina:
 * in trainingsronde 4 was de graphic in drie stukken van elk korter dan
 * 3,5 s geknipt, en één stuk had geen gemeten inhoud, waardoor er niets
 * gericht werd. Eén call per pagina.
 */
export async function richtGraphics(
  segmenten: Shot[],
  bronPad: string,
  woorden: BronWoord[] | null,
  log: (m: string) => void = () => {},
  lezer: (bron: string, t: number) => Promise<GraphicItem[]> = leesGraphic,
): Promise<number> {
  if (!woorden?.length) return 0;
  type Stuk = { sc: NonNullable<Shot['scenes']>[number]; van: number; tot: number };
  const stukken: Stuk[] = [];
  for (const seg of segmenten) {
    for (const sc of seg.scenes ?? []) {
      if (sc.gezicht !== false || sc.focus) continue;
      const van = Math.max(seg.start, sc.van);
      const tot = Math.min(seg.end, sc.tot);
      if (tot > van) stukken.push({ sc, van, tot });
    }
  }
  stukken.sort((a, b) => a.van - b.van);
  // Pagina's: stukken die in de bron op elkaar aansluiten (of overlappen).
  const paginas: Stuk[][] = [];
  for (const st of stukken) {
    const laatste = paginas[paginas.length - 1];
    if (laatste && st.van <= Math.max(...laatste.map((x) => x.tot)) + 0.15) laatste.push(st);
    else paginas.push([st]);
  }
  let gericht = 0;
  for (const pagina of paginas) {
    const van = Math.min(...pagina.map((x) => x.van));
    const tot = Math.max(...pagina.map((x) => x.tot));
    if (tot - van < instelling('GRAPHIC_BEWEGING_VANAF')) continue;
    // Het laatste vasthoudmoment van de pagina: daar staat alles erop.
    const momenten = pagina.map((x) => x.sc.bevries).filter((t): t is number => typeof t === 'number' && t >= van && t <= tot);
    const moment = momenten.length ? Math.max(...momenten) : van + 0.8 * (tot - van);
    const items = await lezer(bronPad, moment);
    const genoemd = focusPunten(items, woorden, van, tot);
    const titel = items.find((x) => x.titel)?.box;
    // Noemt de spreker de blokken niet, dan is er geen reden om naar een blok
    // te gaan: de rustige push-in op de hele graphic blijft staan. Blokken
    // aflopen in leesvolgorde (rondes 9-13) sneed de buurblokken af terwijl de
    // spreker het over iets anders had.
    const basis = genoemd;
    let punten = basis;
    // Na het laatste blok terug naar het hele beeld als de pagina daarna nog
    // blijft staan: in trainingsronde 10 bleef de zoom op blok 3 hangen terwijl
    // de spreker al over "vier jaar tekort" praatte.
    const laatste = punten[punten.length - 1];
    if (laatste && tot - (laatste.t + instelling('GRAPHIC_FOCUS_VASTHOUDEN')) > 0.5) {
      punten = [...punten, { t: laatste.t + instelling('GRAPHIC_FOCUS_VASTHOUDEN'), cx: 0.5, cy: 0.5, b: 1, h: 1 }];
    }
    if (titel) punten = punten.map((p) => ({ ...p, titel }));
    if (basis.length < 2) {
      log(`graphic ${van.toFixed(1)}–${tot.toFixed(1)} s: ${items.length} blok(ken) gelezen, ${genoemd.length} genoemd — geen gerichte zoom`);
      continue;
    }
    for (const st of pagina) st.sc.focus = punten;
    gericht++;
    log(`graphic ${van.toFixed(1)}–${tot.toFixed(1)} s: ${genoemd.length} punten gericht${titel ? ', titel blijft in beeld' : ''}${punten.length > basis.length ? ', daarna terug naar het geheel' : ''} (${items.filter((i) => !i.titel).map((i) => i.tekst).join(' / ')})`);
  }
  return gericht;
}

function frame(bron: string, seconde: number, pad: string): Promise<boolean> {
  return new Promise((klaar) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      ['-nostdin', '-y', '-ss', Math.max(0, seconde).toFixed(2), '-i', bron, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', pad],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    kind.on('error', () => klaar(false));
    kind.on('close', (code) => klaar(code === 0 && existsSync(pad)));
  });
}
