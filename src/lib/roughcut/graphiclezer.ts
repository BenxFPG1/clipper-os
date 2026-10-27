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

export type GraphicItem = { tekst: string; box: Box };
/** Een zoompunt: op brontijd t richt het beeld op (cx, cy) in het volle bronbeeld, met de breedte en hoogte van het blok. */
export type FocusPunt = { t: number; cx: number; cy: number; b: number; h: number };

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
});

/** Leest de tekstblokken (punten, kolommen, labels) van één graphic-frame. Leeg bij een fout. */
export async function leesGraphic(bronPad: string, seconde: number): Promise<GraphicItem[]> {
  const map = await mkdtemp(join(tmpdir(), 'clipper-graphic-'));
  try {
    const pad = join(map, 'graphic.jpg');
    if (!(await frame(bronPad, seconde, pad))) return [];
    const uit = await structuredCall({
      system:
        'Je leest een informatieve graphic uit een video (een dia met punten, kolommen of een grafiek). Geef de afzonderlijke inhoudsblokken die een spreker na elkaar zou noemen: per blok de tekst (de kop of het label) en het vak waarin het blok staat, als fracties van de beeldbreedte en -hoogte (0 = links/boven, 1 = rechts/onder). Niet de titel van de hele dia, geen logo, geen bronvermelding. Zijn er geen afzonderlijke blokken, geef dan een lege lijst.',
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
    return uit.items
      .filter((i) => i.x1 > i.x0 && i.y1 > i.y0 && i.tekst.trim().length >= 2)
      .map((i) => ({ tekst: i.tekst.trim(), box: { x0: i.x0, y0: i.y0, x1: i.x1, y1: i.y1 } }));
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
  for (const item of items) {
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
 * de scène (scene.focus). Eén call per graphic-scène, gecachet op brontijd.
 */
export async function richtGraphics(
  segmenten: Shot[],
  bronPad: string,
  woorden: BronWoord[] | null,
  log: (m: string) => void = () => {},
  lezer: (bron: string, t: number) => Promise<GraphicItem[]> = leesGraphic,
): Promise<number> {
  if (!woorden?.length) return 0;
  const gelezen = new Map<string, GraphicItem[]>();
  let gericht = 0;
  for (const seg of segmenten) {
    for (const sc of seg.scenes ?? []) {
      if (sc.gezicht !== false || !sc.inhoud || sc.focus) continue;
      const van = Math.max(seg.start, sc.van);
      const tot = Math.min(seg.end, sc.tot);
      if (tot - van < instelling('GRAPHIC_BEWEGING_VANAF')) continue;
      const moment = sc.bevries ?? van + 0.7 * (tot - van);
      const sleutel = moment.toFixed(1);
      if (!gelezen.has(sleutel)) gelezen.set(sleutel, await lezer(bronPad, moment));
      const items = gelezen.get(sleutel)!;
      const punten = focusPunten(items, woorden, sc.van, sc.tot);
      if (punten.length >= 2) {
        sc.focus = punten;
        gericht++;
        log(`graphic ${van.toFixed(1)} s: ${punten.length} punten gericht (${items.filter((i) => punten.some((p) => Math.abs(p.cx - (i.box.x0 + i.box.x1) / 2) < 1e-6)).map((i) => i.tekst).join(' → ')})`);
      }
    }
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
