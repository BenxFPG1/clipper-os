import { z } from 'zod';
import { structuredCall } from '../claude';
import { db } from '../supabase';
import { EDITCRAFT } from '../vault/editcraft';
import { EFFECTEN } from '../vault/effecten';
import { geleerdeKennis } from '../vault/kennis';

export const EDIT_PROMPT_VERSIE = 'edit-1.0';

const editSchema = z.object({
  clips: z.array(
    z.object({
      clip_nummer: z.number().int().min(1),
      kader: z.enum(['vullend', 'blur', 'origineel']),
      muziek: z.enum(['geen', 'spanningsbed', 'opbouw', 'luchtig']),
      shots: z.array(
        z.object({
          volgorde: z.number().int().min(1),
          focus: z.enum(['links', 'midden', 'rechts', 'auto']),
          beeld_effect: z.string().describe('Slug uit de effectenvault, of "geen".'),
          sfx: z.string().describe('Slug uit de effectenvault, of "geen".'),
          tekstkaart: z
            .string()
            .nullable()
            .describe('Regel die als kaart in beeld komt (bv. bij een tijdsprong), of null.'),
          waarom: z.string().describe('Naar welke regel uit de werkwijze deze keuze verwijst.'),
        }),
      ),
      stiltemoment: z
        .string()
        .nullable()
        .describe('Waar de muziek volledig moet wegvallen en waarom; null als dat niet speelt.'),
      eindcontrole: z.string().describe('Uitkomst van stap 7: wat is de zwakste plek van deze montage?'),
    }),
  ),
});

export type EditBeslissingen = z.infer<typeof editSchema>;

const EDIT_SYSTEM = `Je bent de edit-agent. Je krijgt een clip-plan (het verhaal ligt vast) en jij bepaalt HOE het gemonteerd wordt: kader, focus, beeldingrepen, geluid en tekst per shot.

Je verzint geen verhaal en verschuift geen tijdcodes — dat is het werk van de planner. Jij neemt uitvoerende beslissingen en verantwoordt elke keuze met een regel uit de werkwijze hieronder.

Werk de zeven stappen af in volgorde en denk per shot:
- Is dit een naad binnen dezelfde opname? Dan moet hij afgedekt: insert, kaderwissel (>10% schaalverschil) of naar de reactie. Nooit twee identieke kadreringen achter elkaar.
- Wie moet de kijker zien: de spreker of de reactie? Zet focus op "auto" als de gezichtsdetectie het mag bepalen, en kies expliciet links/midden/rechts als het script of de inhoud iets anders vraagt (een reactie, een object).
- Verdient dit shot een ingreep, of redt het zich? Hoogstens twee ingrepen per shot; een ingreep zonder functie kost aandacht.
- Is dit een tijdsprong? Dan verplicht een tekstkaart met de sprong erop.
- Kader: verticaal beeld hoort gevuld. "vullend" is de norm; "blur" alleen als de uitsnede echt iets belangrijks afsnijdt (twee mensen naast elkaar, tekst in beeld). Zwarte balken bestaan niet.
- Waar valt de muziek weg? Op de payoff of een vragende beat — dat is het moment dat je groot maakt.

Sluit per clip af met de eindcontrole: benoem de zwakste plek van de montage die je zojuist hebt ontworpen. Niet "ziet er goed uit" — een concreet zwak punt.`;

/**
 * Bepaalt hoe de clips van een video gemonteerd worden en bewaart dat bij het
 * plan. Eén call voor alle clips van een video: dat scheelt fors in de
 * abonnementslimiet en geeft de agent overzicht om af te wisselen in kader en
 * ingrepen — drie clips achter elkaar in hetzelfde kader is precies wat we
 * willen vermijden.
 */
export async function runEditAgent(
  videoId: string,
  opties: { opnieuw?: boolean; onVoortgang?: (m: string) => void } = {},
) {
  const supabase = db();

  const { data: planRij, error } = await supabase
    .from('clip_plans')
    .select('id, plan, edit_beslissingen')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error) throw new Error('Geen clip-plan gevonden.');

  const bestaand = opties.opnieuw ? null : (planRij.edit_beslissingen as EditBeslissingen | null);

  const clips = ((planRij.plan as { clips?: unknown[] }).clips ?? []) as {
    titel_intern: string;
    hook?: { tekst_overlay?: string };
    shots: { volgorde: number; functie: string; start: number; end: number; transcript_fragment?: string; edit_notitie?: string }[];
  }[];
  if (clips.length === 0) throw new Error('Het plan bevat geen clips.');

  // Alleen wat de edit-agent nodig heeft: verhaal en tekst, geen vault-gewichten
  // of campagneregels. Dat scheelt invoer en houdt hem bij zijn taak.
  const compact = clips.map((c, i) => ({
    clip_nummer: i + 1,
    titel: c.titel_intern,
    hook: c.hook?.tekst_overlay ?? null,
    shots: c.shots.map((s) => ({
      volgorde: s.volgorde,
      functie: s.functie,
      duur: Math.round((s.end - s.start) * 10) / 10,
      bron_tijd: Math.round(s.start),
      tekst: (s.transcript_fragment ?? '').slice(0, 180),
      notitie: (s.edit_notitie ?? '').slice(0, 180),
    })),
  }));

  // In batches van zes clips: één antwoord voor 23 clips wordt zo lang dat de
  // verbinding halverwege afbreekt. Kleinere brokken komen betrouwbaar door en
  // de agent houdt genoeg overzicht om af te wisselen in kader.
  const BATCH = Number(process.env.EDIT_BATCH ?? 4);
  const alleClips: EditBeslissingen['clips'] = [...(bestaand?.clips ?? [])];
  const gedaan = new Set(alleClips.map((c) => c.clip_nummer));
  const teDoen = compact.filter((c) => !gedaan.has(c.clip_nummer));

  for (let i = 0; i < teDoen.length; i += BATCH) {
    const brok = teDoen.slice(i, i + BATCH);
    const deel = await editCall(brok, alleClips.map((c) => c.kader));
    alleClips.push(...deel.clips);

    // Na elke batch wegschrijven: breekt de run af (limiet, timeout), dan is
    // het gedane werk niet weg en pakt de volgende run alleen de rest.
    await supabase
      .from('clip_plans')
      .update({
        edit_beslissingen: { clips: alleClips },
        edit_prompt_versie: EDIT_PROMPT_VERSIE,
      })
      .eq('id', planRij.id);
    opties.onVoortgang?.(`montage ontworpen voor ${alleClips.length}/${compact.length} clips`);
  }

  return { clips: alleClips };
}

/** Eén call voor een groepje clips. */
async function editCall(
  brok: unknown[],
  eerdereKaders: string[],
): Promise<EditBeslissingen> {
  return structuredCall({
    system: `${EDIT_SYSTEM}

${EDITCRAFT}

${EFFECTEN}${await geleerdeKennis()}`,
    user: `Ontwerp de montage voor deze ${brok.length} clips.

Let op de samenhang: wissel het kader af over de clips heen, en herhaal niet steeds dezelfde ingreep.${
      eerdereKaders.length ? `\nEerder in deze video gekozen kaders: ${eerdereKaders.join(', ')} — varieer hierop.` : ''
    }

${JSON.stringify(brok, null, 2)}`,
    schema: editSchema,
    toolName: 'lever_edit_beslissingen',
    toolDescription: 'Lever per clip en per shot de montagebeslissingen.',
    maxTokens: 32000,
    effort: 'high',
    operation: 'edit_agent',
  });
}

/** Zoekt de beslissingen voor één clip op; null als de agent nog niet draaide. */
export function beslissingenVoorClip(
  beslissingen: EditBeslissingen | null,
  clipNummer: number,
): EditBeslissingen['clips'][number] | null {
  return beslissingen?.clips.find((c) => c.clip_nummer === clipNummer) ?? null;
}
