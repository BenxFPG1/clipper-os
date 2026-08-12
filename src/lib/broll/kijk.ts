import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { structuredCall } from '../claude';
import { resolveBinary } from '../ingest/binaries';

/**
 * De kijk-agent: categoriseert b-roll door er echt naar te kijken.
 *
 * De mechanische analyse (analyse.ts) weet wáár de shotgrenzen zitten en
 * hoeveel er beweegt; deze laag weet wat er te zíen is. Dat is wat de
 * edit-planner nodig heeft om shots te combineren die bij elkaar passen:
 * je knipt een close-up van een product niet tegen een drukke straatscène
 * aan, en drie shots met dezelfde kleurtoon en locatie vormen samen een
 * sequentie in plaats van drie losse plaatjes.
 *
 * Frames extraheren is goedkoop (ffmpeg), het kijken zelf draait op het
 * lichte model met lage effort — het is beschrijven, geen creatief werk.
 */

export const kijkSchema = z.object({
  shots: z.array(
    z.object({
      index: z.number().int().min(0),
      /** Eén zin: wat zie je. Concreet — "handen die een horloge omdoen", niet "een product". */
      beschrijving: z.string(),
      categorie: z.enum(['product', 'close_up', 'persoon', 'actie', 'locatie', 'sfeer', 'tekst_of_logo', 'overig']),
      /** De visuele stemming: "warm gouden avondlicht", "klinisch wit studiolicht". */
      sfeer: z.string(),
      /** Dominante kleuren, voor visueel rijm tussen shots. */
      kleuren: z.array(z.string()).max(4),
      /** Vrije trefwoorden om op te matchen: onderwerp, setting, beweging. */
      tags: z.array(z.string()).max(6),
      /** Onbruikbaar materiaal (onscherp, per ongeluk gefilmd, testbeeld) eerlijk markeren. */
      bruikbaar: z.boolean(),
    }),
  ),
});

export type KijkOordeel = z.infer<typeof kijkSchema>['shots'][number];

const SYSTEM = `Je kijkt naar frames uit losse b-roll-shots voor een short-form edit. Per shot krijg je één of twee beelden.

Beschrijf per shot wat er echt te zien is — concreet en visueel, zodat een editor die de beelden niet ziet er toch mee kan monteren:
- "beschrijving": wat er gebeurt of getoond wordt, in één concrete zin.
- "categorie": het soort shot.
- "sfeer": licht en stemming, in een paar woorden.
- "kleuren": de dominante kleuren.
- "tags": trefwoorden waarop shots gematcht kunnen worden (onderwerp, setting, bewegingsrichting).
- "bruikbaar": false alleen bij materiaal dat echt niet in een edit kan (onscherp, per ongeluk gefilmd, kleurenbalk).

Wees feitelijk. Geen oordeel over of het mooi is; wel eerlijk over wat er staat.`;

/** Hoeveel shots per vision-call; meer beelden per call wordt onbetrouwbaar. */
const PER_CALL = 8;

export async function bekijkBroll(
  bestanden: { pad: string; duur: number }[],
  werkmap: string,
): Promise<(KijkOordeel | null)[]> {
  // Frames: één op 30% voor korte shots, plus één op 70% voor langere — een
  // shot van 20 seconden kan halverwege iets heel anders laten zien.
  const beelden: { bestandIndex: number; pad: string }[] = [];
  for (const [i, b] of bestanden.entries()) {
    const punten = b.duur > 8 ? [0.3, 0.7] : [0.4];
    for (const [k, f] of punten.entries()) {
      const beeldPad = join(werkmap, `kijk-${String(i).padStart(3, '0')}-${k}.jpg`);
      await new Promise<void>((klaar) => {
        const kind = spawn(resolveBinary('ffmpeg'), [
          '-nostdin', '-y', '-ss', (b.duur * f).toFixed(2), '-i', b.pad,
          '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', beeldPad,
        ], { stdio: ['ignore', 'ignore', 'ignore'] });
        kind.on('error', () => klaar());
        kind.on('close', () => klaar());
      });
      if (existsSync(beeldPad)) beelden.push({ bestandIndex: i, pad: beeldPad });
    }
  }

  const uit: (KijkOordeel | null)[] = bestanden.map(() => null);

  // In groepen kijken; per groep de bestandsindexen meesturen zodat het
  // antwoord terug te koppelen is.
  const groepen: number[][] = [];
  {
    const uniek = [...new Set(beelden.map((b) => b.bestandIndex))];
    for (let i = 0; i < uniek.length; i += PER_CALL) groepen.push(uniek.slice(i, i + PER_CALL));
  }

  for (const groep of groepen) {
    const groepBeelden = beelden.filter((b) => groep.includes(b.bestandIndex));
    try {
      const oordeel = await structuredCall({
        system: SYSTEM,
        user: `Je krijgt ${groepBeelden.length} beelden van ${groep.length} shots, in deze volgorde: ${groepBeelden
          .map((b) => `shot ${b.bestandIndex}`)
          .join(', ')}. Shots met twee beelden tonen begin en verderop van hetzelfde shot.

Lever per shot (index ${groep.join(', ')}) één beoordeling.`,
        schema: kijkSchema,
        toolName: 'lever_kijkoordeel',
        toolDescription: 'Lever per b-roll-shot de visuele beschrijving en categorie.',
        maxTokens: 8000,
        effort: 'low',
        operation: 'broll_kijk',
        beeldPaden: groepBeelden.map((b) => b.pad),
        model: process.env.CLAUDE_LICHT_MODEL,
      });
      for (const shot of oordeel.shots) {
        if (shot.index >= 0 && shot.index < uit.length) uit[shot.index] = shot;
      }
    } catch (e) {
      console.warn(`[broll] kijkronde mislukt (${(e as Error).message.slice(0, 80)}); shots blijven ongecategoriseerd`);
    }
  }

  return uit;
}
