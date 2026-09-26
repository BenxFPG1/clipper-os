import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { structuredCall } from '../claude';
import { db } from '../supabase';
import { BEELD_EFFECTEN_BEKEND, KADERS } from '../roughcut/kader';
import { EDITCRAFT } from '../vault/editcraft';
import { EFFECTEN } from '../vault/effecten';
import { geleerdeKennis } from '../vault/kennis';
import { editNormenVoorPrompt, type NormContext } from '../vault/normen';

export const EDIT_PROMPT_VERSIE = 'edit-1.2';

/**
 * Wat de render werkelijk kan uitvoeren. De effectenvault beschrijft ook
 * ingrepen die (nog) niet bestaan in de keten — crowd_reactie zonder bestand,
 * speed_ramp, slow_motion, pijl_of_cirkel, split_screen. Die kreeg de agent
 * wél te zien, koos ze, en "verantwoordde" ingrepen die nooit gebeurden. Hier
 * wordt de vaulttekst gefilterd op wat er echt is: sfx-bestanden in
 * assets/sfx, de beeldingrepen die effectKeten kent, en de muziekbedden in
 * assets/muziek.
 */
export function effectenVoorRender(): string {
  const sfxMap = join(process.cwd(), 'assets', 'sfx');
  const muziekMap = join(process.cwd(), 'assets', 'muziek');
  const bestandSlugs = (map: string) =>
    existsSync(map) ? readdirSync(map).map((b) => b.replace(/\.(wav|mp3)$/i, '')) : [];
  const bekend = new Set<string>([
    'geen',
    'stilte',
    ...bestandSlugs(sfxMap),
    ...bestandSlugs(muziekMap),
    ...BEELD_EFFECTEN_BEKEND,
    ...KADERS,
  ]);
  return EFFECTEN.split('\n')
    .filter((regel) => {
      const m = regel.match(/^- ([a-z_]+):/);
      return !m || bekend.has(m[1]);
    })
    .join('\n');
}

/** Slugs die de render kent; alles daarbuiten wordt bij toepassing gelogd en genegeerd. */
export function bekendeEffectSlugs(): Set<string> {
  const bekend = new Set<string>(['geen', 'stilte', ...BEELD_EFFECTEN_BEKEND]);
  const sfxMap = join(process.cwd(), 'assets', 'sfx');
  if (existsSync(sfxMap)) for (const b of readdirSync(sfxMap)) bekend.add(b.replace(/\.(wav|mp3)$/i, ''));
  return bekend;
}

/** Meetdata per shot, uit de gezichtsdetectie: wat de agent níet uit tekst kan halen. */
export type ShotMeting = { personen?: number; spreiding?: number; focusX?: number };
export type PlanMeetdata = Record<number, Record<number, ShotMeting>>;

const editSchema = z.object({
  clips: z.array(
    z.object({
      clip_nummer: z.number().int().min(1),
      kader: z.enum(['vullend', 'blur', 'origineel']),
      muziek: z.enum(['geen', 'spanningsbed', 'opbouw', 'luchtig']),
      shots: z.array(
        z.object({
          volgorde: z.number().int().min(1),
          focus: z
            .enum(['links', 'midden', 'rechts', 'auto'])
            .describe('Alleen anders dan "auto" als er meerdere personen in beeld staan én de kijker de ander moet zien.'),
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
      rehook: z
        .string()
        .nullable()
        .describe(
          'Korte re-hookregel (hoogstens zes woorden, spreektaal) die de render in het grootste risicogat vóór de payoff zet; null als de clip zonder kan.',
        ),
      eindcontrole: z.string().describe('Uitkomst van stap 7: wat is de zwakste plek van deze montage?'),
    }),
  ),
});

export type EditBeslissingen = z.infer<typeof editSchema>;

const EDIT_SYSTEM = `Je bent de edit-agent. Je krijgt een clip-plan (het verhaal ligt vast) en jij bepaalt HOE het gemonteerd wordt: kader, focus, beeldingrepen, geluid en tekst per shot.

Je verzint geen verhaal en verschuift geen tijdcodes — dat is het werk van de planner. Jij neemt uitvoerende beslissingen en verantwoordt elke keuze met een regel uit de werkwijze hieronder.

Werk de zeven stappen af in volgorde en denk per shot:
- Is dit een naad binnen dezelfde opname? Dan moet hij afgedekt: insert, kaderwissel (>10% schaalverschil) of naar de reactie. Nooit twee identieke kadreringen achter elkaar.
- Wie moet de kijker zien: de spreker of de reactie? De gezichtsdetectie kadreert standaard op wie er praat; "auto" is dus de norm. Per shot krijg je de meting mee (personen in beeld, hoe ver de spreker beweegt, waar hij staat). Kies alleen expliciet links/midden/rechts als er méér dan één persoon in beeld staat én de reactie van de ander sterker is dan de spreker — bij één persoon wordt een eigen focus genegeerd.
- Kies alleen ingrepen uit de effectenvault hieronder: die lijst is precies wat de render kan uitvoeren. Een slug die er niet in staat wordt genegeerd.
- Verdient dit shot een ingreep, of redt het zich? Hoogstens twee ingrepen per shot; een ingreep zonder functie kost aandacht.
- Is dit een tijdsprong? Dan verplicht een tekstkaart met de sprong erop.
- Kader: verticaal beeld hoort gevuld. "vullend" is de norm; "blur" alleen als de uitsnede echt iets belangrijks afsnijdt (twee mensen naast elkaar, tekst in beeld). Zwarte balken bestaan niet.
- Waar valt de muziek weg? Op de payoff of een vragende beat — dat is het moment dat je groot maakt.
- Retentie: per clip krijg je een gemeten risicosamenvatting ("retentie": waar de kijker volgens de meting afhaakt, per shot en seconde, met de reden). De render knipt pauzes zelf weg en zet zelf kaderwissels waar het beeld te lang stilstaat — dat hoef jij niet te doen. Jouw taak is kiezen WAAR een ingreep het verschil maakt, niet hoeveel: leg sfx, beeldingrepen en kaarten op de shots met een risicopiek, en laat shots zonder risico met rust ("geen"). Geef een "rehook" als er een risicopiek vóór de payoff zit die een regel tekst kan dichten.

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
  opties: {
    opnieuw?: boolean;
    onVoortgang?: (m: string) => void;
    meetdata?: PlanMeetdata;
    /** Per clipnummer de retentiesamenvatting (retentie.ts → samenvatVoorEditAgent). */
    retentie?: Record<number, string>;
    /** Platform en thema van de campagne: bepalen welke gemeten normen van anderen gelden. */
    normContext?: NormContext;
  } = {},
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
    shots: c.shots.map((s) => {
      const meting = opties.meetdata?.[i + 1]?.[s.volgorde];
      return {
        volgorde: s.volgorde,
        functie: s.functie,
        duur: Math.round((s.end - s.start) * 10) / 10,
        bron_tijd: Math.round(s.start),
        tekst: (s.transcript_fragment ?? '').slice(0, 180),
        notitie: (s.edit_notitie ?? '').slice(0, 180),
        // Uit de gezichtsdetectie: wat er te zíen is, niet wat de tekst suggereert.
        ...(meting
          ? {
              meting: {
                personen: meting.personen ?? null,
                spreker_x: meting.focusX !== undefined ? Math.round(meting.focusX * 100) / 100 : null,
                beweegt: (meting.spreiding ?? 0) > 0.08,
              },
            }
          : {}),
      };
    }),
    ...(opties.retentie?.[i + 1] ? { retentie: opties.retentie[i + 1] } : {}),
  }));

  // Wat top-clips van anderen meetbaar doen: de doelen waar de retentie-editor
  // op stuurt, als leesbare regels. Leeg zolang er niets gemeten is.
  const normen = await editNormenVoorPrompt(opties.normContext ?? {}).catch(() => '');

  // In batches van zes clips: één antwoord voor 23 clips wordt zo lang dat de
  // verbinding halverwege afbreekt. Kleinere brokken komen betrouwbaar door en
  // de agent houdt genoeg overzicht om af te wisselen in kader.
  const BATCH = Number(process.env.EDIT_BATCH ?? 4);
  const alleClips: EditBeslissingen['clips'] = [...(bestaand?.clips ?? [])];
  const gedaan = new Set(alleClips.map((c) => c.clip_nummer));
  const teDoen = compact.filter((c) => !gedaan.has(c.clip_nummer));

  for (let i = 0; i < teDoen.length; i += BATCH) {
    const brok = teDoen.slice(i, i + BATCH);
    const deel = await editCall(brok, alleClips.map((c) => c.kader), normen);
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
  normen = '',
): Promise<EditBeslissingen> {
  return structuredCall({
    system: `${EDIT_SYSTEM}

${EDITCRAFT}

${effectenVoorRender()}${normen ? `\n\nGEMETEN BIJ TOP-CLIPS VAN ANDEREN (de doelen waar de retentiecurve tegen gemeten is):\n${normen}` : ''}${await geleerdeKennis('edit')}`,
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
