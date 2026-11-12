import { z } from 'zod';
import { structuredCall } from '../claude';
import { PLAN_VERHAALDOKTER_EFFORT } from '../env';
import { sprongen } from './clipregels';
import type { Clip, ClipPlan } from './schema';

/**
 * De verhaaltoets: is een verhaalclip (stukken uit verschillende delen van de
 * video) voor een kijker ook echt één verhaal?
 *
 * Waarom een aparte toets. De planner bedenkt de verhaalclip én beoordeelt
 * hem, met zijn eigen uitleg ernaast (verhaallijn, brug, "waarom dit werkt").
 * Zo overtuigt hij zichzelf. De eerste verhaalclip (Jan Longeval, "De
 * psycholoog en zijn eigen trauma") kreeg een 7: 170 denkfouten → nieuwe
 * beleggers vinden het te makkelijk → zijn eigen trauma uit 1990. Het verband
 * ("hij is er zelf één van") stond alleen in de overlay en in de uitleg; de
 * spreker legt het nergens, en de brug verwees naar een zin die niet in de
 * clip zat. Een kijker hoorde drie losse uitspraken.
 *
 * Deze toets krijgt daarom alléén wat de kijker hoort: de gesproken tekst per
 * stuk, met de sprongen gemarkeerd. Geen titel, geen overlay, geen uitleg.
 * Twijfel is afkeuren: een verhaalclip die niet evident loopt, is een collage.
 */

export const verhaaltoetsSchema = z.object({
  oordelen: z.array(
    z.object({
      clip: z.number().int().describe('Het nummer van de clip zoals aangeleverd.'),
      navertelling: z.string().describe('Het verhaal in één zin, zoals je het aan iemand zou navertellen. Lukt dat niet zonder "en", "ook" of "daarnaast" tussen losse punten, dan is het geen verhaal.'),
      sprongen: z.array(
        z.object({
          naar_stuk: z.number().int().describe('Het nummer van het stuk ná de sprong.'),
          volgt: z.boolean().describe('Volgt dit stuk uit wat er vlak ervoor GEZEGD is: het antwoord, het bewijs, het gevolg, de tegenstelling of de afloop daarvan? Hetzelfde onderwerp of dezelfde spreker is niet genoeg.'),
          waarom: z.string(),
        }),
      ),
      slot_lost_begin_in: z.boolean().describe('Roept het eerste stuk een vraag of verwachting op die het laatste stuk beantwoordt of breekt — in woorden die de spreker zelf zegt?'),
      verband_staat_in_de_tekst: z.boolean().describe('Legt de spreker het verband tussen de stukken zelf (met woorden als "dus", "daarom", "en toen", een naam of onderwerp dat terugkomt), of moet de kijker het zelf bedenken?'),
      oordeel: z.enum(['een_verhaal', 'losse_uitspraken']),
    }),
  ),
});
export type Verhaaltoets = z.infer<typeof verhaaltoetsSchema>;

export const VERHAALTOETS_SYSTEM = `Je bent een strenge eindredacteur van korte video's. Je krijgt clips die uit meerdere stukken van een lange video zijn samengesteld. Je hebt de video NIET gezien en je krijgt geen titel, geen tekst in beeld en geen uitleg van de maker: alleen wat de kijker HOORT, per stuk, met de sprongen gemarkeerd.

Jouw vraag is één ding: is dit voor iemand die alleen dit hoort één verhaal, of zijn het losse uitspraken achter elkaar?

Zo beoordeel je:
1. Vertel de clip na in één zin. Een verhaal heeft een lijn: iets wordt beweerd en bewezen, beloofd en gebroken, gevraagd en beantwoord, opgebouwd en omgedraaid. Kun je het alleen navertellen als opsomming ("hij zegt dit, en ook dat, en dan nog dit"), dan is het geen verhaal.
2. Per sprong: volgt het stuk erna uit wat er vlak ervoor GEZEGD is? Hetzelfde thema, dezelfde spreker of een slim verband dat jij erin kunt lezen telt niet. Het verband moet te horen zijn.
3. Lost het slot in wat het begin opende? Een sterke slotzin die niets met het begin te maken heeft, is een ander verhaal.
4. Legt de spreker het verband zelf, of moet de kijker het bedenken? Moet de kijker het bedenken, dan is het geen verhaalclip.

Wees streng. Twijfel je, dan is het "losse_uitspraken". Liever geen verhaalclip dan een collage: een collage kost de kijker en het account meer dan hij oplevert.`;

/** Wat de kijker hoort, per stuk, met de sprongen ertussen gemarkeerd. */
export function verhaalVoorToets(clip: Pick<Clip, 'shots'>): string {
  const shots = [...clip.shots].sort((a, b) => a.volgorde - b.volgorde);
  const naSprong = new Set(sprongen({ shots }).map((s) => s.volgorde));
  let stuk = 1;
  const regels: string[] = [];
  for (const [i, s] of shots.entries()) {
    if (i > 0 && naSprong.has(s.volgorde)) {
      stuk++;
      regels.push(`— SPRONG naar een ander deel van de video —`);
    }
    regels.push(`[stuk ${stuk}] ${(s.transcript_fragment ?? '').trim()}`);
  }
  return regels.join('\n');
}

/** Het mechanische eindoordeel uit de antwoorden: alles moet kloppen, anders valt de clip af. */
export function verhaalHaaltDeToets(o: Verhaaltoets['oordelen'][number]): { goed: boolean; reden: string } {
  const mis = o.sprongen.filter((s) => !s.volgt);
  if (o.oordeel !== 'een_verhaal') return { goed: false, reden: `losse uitspraken ("${o.navertelling.slice(0, 120)}")` };
  if (mis.length) return { goed: false, reden: `stuk ${mis.map((s) => s.naar_stuk).join(', ')} volgt niet uit het vorige (${mis[0].waarom.slice(0, 120)})` };
  if (!o.slot_lost_begin_in) return { goed: false, reden: 'het slot lost niet in wat het begin opende' };
  if (!o.verband_staat_in_de_tekst) return { goed: false, reden: 'de spreker legt het verband niet zelf; de kijker moet het bedenken' };
  return { goed: true, reden: o.navertelling };
}

/**
 * Toetst alle verhaalclips in het plan in één aanroep en haalt eruit wat de
 * toets niet haalt. Mislukt de aanroep, dan vallen de verhaalclips ook af:
 * een ongetoetste verhaalclip is precies het risico dat deze toets wegneemt.
 * Blijft er dan niets over, dan blijft het plan zoals het was.
 */
export async function toetsVerhaalclips(
  plan: ClipPlan,
  log: (m: string) => void = () => undefined,
  roep: typeof structuredCall = structuredCall,
): Promise<ClipPlan> {
  const verhalen = plan.clips.map((c, i) => ({ c, nr: i + 1 })).filter(({ c }) => c.soort === 'verhaal');
  if (verhalen.length === 0) return plan;

  const weg = new Set<Clip>();
  try {
    const uit = await roep({
      system: VERHAALTOETS_SYSTEM,
      user: verhalen.map(({ c, nr }) => `=== CLIP ${nr} ===\n${verhaalVoorToets(c)}`).join('\n\n'),
      schema: verhaaltoetsSchema,
      toolName: 'lever_verhaaltoets',
      toolDescription: 'Lever per clip het oordeel: één verhaal of losse uitspraken.',
      maxTokens: 6000,
      effort: PLAN_VERHAALDOKTER_EFFORT,
      operation: 'clip_plan_verhaaltoets',
    });
    for (const { c, nr } of verhalen) {
      const o = uit.oordelen.find((x) => x.clip === nr);
      const r = o ? verhaalHaaltDeToets(o) : { goed: false, reden: 'geen oordeel teruggekregen' };
      log(`verhaaltoets "${c.titel_intern}": ${r.goed ? 'één verhaal' : 'AFGEKEURD'} — ${r.reden}`);
      if (!r.goed) weg.add(c);
    }
  } catch (e) {
    log(`verhaaltoets mislukt (${(e as Error).message.slice(0, 80)}); verhaalclips vallen af`);
    for (const { c } of verhalen) weg.add(c);
  }
  const over = plan.clips.filter((c) => !weg.has(c));
  return over.length ? { clips: over } : plan;
}
