import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { structuredCall } from '../claude';
import { db } from '../supabase';
import { pakFrames } from '../roughcut/frames';
import { EDITCRAFT } from '../vault/editcraft';
import { STORYCRAFT } from '../vault/storycraft';

const analyseSchema = z.object({
  hook_visueel: z.string().describe('Wat er in de eerste seconden in beeld gebeurt en waarom dat vasthoudt.'),
  kader_en_tekst: z.string().describe('Kadrering, tekststijl, plek van de ondertiteling, kleurgebruik.'),
  ritme: z.string().describe('Hoe vaak het beeld verandert en waar het vertraagt of versnelt.'),
  overdraagbare_les: z
    .string()
    .describe('Eén regel die wij morgen kunnen toepassen. Concreet en toetsbaar, geen algemeenheid.'),
  categorie: z.enum(['storycraft', 'editcraft', 'onderzoek']),
  niet_overdraagbaar: z
    .string()
    .describe('Wat aan deze clip werkt puur door de maker, het account of het onderwerp — en dus niet kopieerbaar is.'),
});

const KIJK_SYSTEM = `Je analyseert een goed presterende short-form clip die je zowel ziet (frames) als leest (transcript).

Kijk eerst naar de frames vóór je oordeelt. Je beschrijft wat er werkelijk in beeld staat — geen aannames uit de tekst.

Waar je op let:
- De eerste seconden: wat ziet de kijker, waar staat het onderwerp in het kader, welke tekst ligt eroverheen?
- Vormtaal: kadrering, tekststijl en -plek, kleur, ondertiteling.
- Ritme: hoe vaak verandert het beeld, waar wordt vertraagd?

Lever één overdraagbare les die een concrete beslissing verandert ("hooktekst staat op ooghoogte, niet bovenaan"), geen algemeenheid ("goede belichting helpt"). En wees streng over wat NIET overdraagbaar is: wat werkt door de persoon, het account of het onderwerp hoort niet in onze kennisbank.`;

/**
 * Laat Claude een uitschieter écht bekijken in plaats van er alleen over te
 * lezen, en zet de overdraagbare les in de kennisvault.
 *
 * Bewust spaarzaam: beeld kost fors meer tokens dan tekst, dus dit draait op
 * een handvol topvondsten per week — niet op elke clip die de scout ziet.
 */
export async function bekijkUitschieter(findId: string) {
  const supabase = db();

  const { data: find, error } = await supabase
    .from('scout_finds')
    .select('id, post_url, handle, platform, caption, outlier_score, decoded')
    .eq('id', findId)
    .single();
  if (error || !find?.post_url) throw new Error('Vondst niet gevonden of zonder URL.');

  const { map, frames, duur } = await pakFrames(find.post_url as string, { maxFrames: 10 });
  if (frames.length === 0) {
    await rm(map, { recursive: true, force: true });
    throw new Error('Geen frames kunnen pakken.');
  }

  try {
    const analyse = await structuredCall({
      system: `${KIJK_SYSTEM}\n\n${STORYCRAFT}\n\n${EDITCRAFT}`,
      user: `Bekijk deze clip van @${find.handle} op ${find.platform}${
        find.outlier_score ? ` (${find.outlier_score}x de mediaan van dat account)` : ''
      }.

Duur: ${duur ? `${Math.round(duur)} seconden` : 'onbekend'}
Caption: ${find.caption ?? '—'}
${find.decoded ? `Eerdere tekstanalyse: ${JSON.stringify(find.decoded).slice(0, 800)}` : ''}`,
      schema: analyseSchema,
      toolName: 'lever_visuele_analyse',
      toolDescription: 'Lever de visuele analyse van deze clip.',
      maxTokens: 8000,
      effort: 'high',
      operation: 'visuele_analyse',
      beeldPaden: frames.map((f) => f.pad),
    });

    // De les gaat de kennisvault in en werkt daarmee direct door in de plan-,
    // script- en edit-agent.
    await supabase.from('vault_kennis').insert({
      categorie: analyse.categorie,
      titel: `Gezien bij @${find.handle}: ${analyse.overdraagbare_les.slice(0, 60)}`,
      inhoud: `${analyse.overdraagbare_les}\n\nHook in beeld: ${analyse.hook_visueel}\nKader en tekst: ${analyse.kader_en_tekst}\nRitme: ${analyse.ritme}\nNiet overdraagbaar: ${analyse.niet_overdraagbaar}`,
      bron: `Visuele analyse van ${find.post_url}`,
    });

    await supabase
      .from('scout_finds')
      .update({ decoded: { ...(find.decoded as object | null), visueel: analyse } })
      .eq('id', findId);

    return { analyse, frames: frames.length };
  } finally {
    await rm(map, { recursive: true, force: true });
  }
}

/**
 * Bekijkt de sterkste vondsten die nog niet visueel geanalyseerd zijn.
 * Standaard drie per run: genoeg om te leren, weinig genoeg om de
 * abonnementslimiet niet op te eten.
 */
export async function bekijkTopVondsten(aantal = 3) {
  const supabase = db();
  const { data } = await supabase
    .from('scout_finds')
    .select('id, handle, outlier_score, decoded, post_url')
    .not('post_url', 'is', null)
    .order('outlier_score', { ascending: false, nullsFirst: false })
    .limit(25);

  const teDoen = (data ?? [])
    .filter((f) => !(f.decoded as { visueel?: unknown } | null)?.visueel)
    .slice(0, aantal);

  const gedaan: string[] = [];
  const fouten: string[] = [];
  for (const f of teDoen) {
    try {
      const r = await bekijkUitschieter(f.id as string);
      gedaan.push(`@${f.handle}: ${r.analyse.overdraagbare_les.slice(0, 80)}`);
    } catch (e) {
      fouten.push(`@${f.handle}: ${(e as Error).message.slice(0, 100)}`);
    }
  }
  return { gedaan, fouten };
}
