import { z } from 'zod';
import { structuredCall } from '../claude';
import { PLAN_EFFORT, PLAN_EXAMEN_EFFORT } from '../env';
import { db } from '../supabase';
import { geleerdeKennis } from '../vault/kennis';
import { ONDERZOEK } from '../vault/onderzoek';
import { EFFECTEN } from '../vault/effecten';
import { EDITCRAFT } from '../vault/editcraft';
import { SPREEKTAAL } from '../vault/spreektaal';
import type { BrollAnalyse } from './analyse';
import type { KijkOordeel } from './kijk';

/**
 * De b-roll-editplanner: een edit in plaats van een verhaal-uit-spraak.
 *
 * Zelfde tweetrapsopzet als de gesprekspijplijn (concept → examen), maar het
 * materiaal is fundamenteel anders: er is geen transcript, dus de betekenis
 * komt uit beeldvolgorde, tempo, muziek en tekst-overlays. De stijlgids —
 * gebouwd uit wat de Scout in dit genre ziet werken plus het vaste onderzoek —
 * is het equivalent van de character map: eerst weten wat er in dit genre
 * werkt, dan pas plannen.
 */

export const BROLL_PROMPT_VERSION = 'broll-1.0';

// ------------------------------------------------------------- de stijlgids
export const stijlgidsSchema = z.object({
  /** Wat dit genre kenmerkt bij de best presterende voorbeelden. */
  genre_observaties: z.array(z.string()).min(3),
  /** Tempo: hoe lang shots mogen duren, waar versneld wordt. */
  tempo: z.object({
    shot_seconden_min: z.number().min(0.3),
    shot_seconden_max: z.number().max(8),
    ritme: z.string(),
  }),
  /** De eerste seconde: wat er in beeld moet staan om de scroll te stoppen. */
  eerste_seconde: z.string(),
  overlay_stijl: z.string(),
  muziek_richting: z.string(),
  dos: z.array(z.string()).min(3),
  donts: z.array(z.string()).min(3),
});

export type BrollStijlgids = z.infer<typeof stijlgidsSchema>;

const STIJLGIDS_SYSTEM = `Je bent onderzoeker voor short-form b-roll-edits (product-, lifestyle- en sfeermontages zonder gesproken verhaal). Je krijgt vondsten van goed presterende posts in dit genre plus ons vaste onderzoek, en destilleert daaruit een stijlgids voor de editplanner.

Wees concreet en meetbaar waar het kan: shotlengtes in seconden, niet "vlot". Alles wat je beweert moet steunen op de meegeleverde vondsten of het onderzoek — verzin geen trends.`;

export async function bouwStijlgids(campaignId: string): Promise<BrollStijlgids> {
  const supabase = db();
  const { data: campagne } = await supabase
    .from('campaigns')
    .select('name, theme, platform_rules, broll_stijlgids')
    .eq('id', campaignId)
    .single();

  let findsQuery = supabase
    .from('scout_finds')
    .select('platform, theme, outlier_score, caption, decoded')
    .not('decoded', 'is', null)
    .order('outlier_score', { ascending: false, nullsFirst: false })
    .limit(15);
  if (campagne?.theme) findsQuery = findsQuery.eq('theme', campagne.theme);
  const { data: finds } = await findsQuery;

  const gids = await structuredCall({
    system: STIJLGIDS_SYSTEM,
    user: `Campagne: ${campagne?.name}
Thema: ${campagne?.theme ?? 'onbekend'}

=== CAMPAGNEREGELS ===
${JSON.stringify(campagne?.platform_rules ?? {}, null, 2)}

=== VONDSTEN VAN DE SCOUT (best presterende posts, dit thema) ===
${JSON.stringify(finds ?? [], null, 2)}

${ONDERZOEK}

${EDITCRAFT}`,
    schema: stijlgidsSchema,
    toolName: 'lever_stijlgids',
    toolDescription: 'Lever de b-roll-stijlgids voor deze campagne.',
    maxTokens: 8000,
    effort: PLAN_EXAMEN_EFFORT,
    operation: 'broll_stijlgids',
  });

  await supabase.from('campaigns').update({ broll_stijlgids: gids }).eq('id', campaignId);
  return gids;
}

// ------------------------------------------------------------- het editplan
export const brollShotSchema = z.object({
  volgorde: z.number().int().min(1),
  /** De videos.id van het bronbestand. */
  video_id: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  /** Waarom dít shot hier: het visuele rijm met de buren (kleur, richting, onderwerp). */
  waarom_hier: z.string(),
  overlay_tekst: z.string().nullable(),
  beeld_effect: z.string().optional(),
  spanning: z.number().min(1).max(10),
});

export const brollClipSchema = z.object({
  titel_intern: z.string(),
  /** Wat de edit vertelt zónder woorden: de rode draad van beeld naar beeld. */
  verhaalidee: z.string().min(10),
  hook_overlay: z.string(),
  muziek: z.string(),
  shots: z.array(brollShotSchema).min(3),
  caption: z.object({ tiktok: z.string(), reels: z.string(), shorts: z.string() }),
  score: z.number().min(1).max(10),
  uitval_risicos: z
    .array(z.object({ seconde: z.number(), waarom: z.string(), fix: z.string() }))
    .optional(),
});

export const brollPlanSchema = z.object({
  vorm: z.literal('broll'),
  clips: z.array(brollClipSchema).min(1),
});

export type BrollPlan = z.infer<typeof brollPlanSchema>;
export type BrollClip = z.infer<typeof brollClipSchema>;

const PLAN_SYSTEM = `Je bent editor van short-form b-roll-montages. Je krijgt een bak losse shots — per shot een visuele beschrijving, categorie, sfeer, kleuren, tags, scènegrenzen en duur — en een stijlgids met wat er in dit genre werkt. Er is géén gesproken verhaal: de edit ís het verhaal.

Werkwijze:
1. Groepeer eerst: welke shots horen visueel bij elkaar (zelfde locatie, kleurtoon, onderwerp, bewegingsrichting)? Een sequentie van drie verwante shots vertelt meer dan drie losse plaatjes. Gebruik de categorieën en tags — combineer wat rijmt, en zet contrasten alleen bewust in (een close-up ná een totaal is een onthulling; twee botsende sferen na elkaar is een fout).
2. Bouw per clip een "verhaalidee": de rode draad zonder woorden — van breed naar dichtbij, van probleem naar product, van rust naar climax. Vul per shot "waarom_hier" in: het visuele rijm met de buren.
3. De eerste seconde volgt de stijlgids: het sterkste, meest scroll-stoppende beeld eerst, met de hook-overlay erover.
4. Tempo uit de stijlgids: shotlengtes binnen de genoemde grenzen, korter naarmate de spanning stijgt. Vul "spanning" (1-10) oplopend naar het slot.
5. Knip op scènegrenzen van het bronmateriaal waar die er zijn (meegeleverd per shot) — midden in een camerabeweging knippen oogt als een fout.
6. Overlays dragen de betekenis (er is geen stem): kort, concreet, spreektaal. Niet elk shot een overlay — de stilte tussen teksten geeft ze gewicht.
7. Shots met bruikbaar=false gebruik je nooit. start/end blijven binnen de duur van het bestand.

Lever 2 tot 4 clips, elk 12-30 seconden, gesorteerd op score (eerlijk beoordeeld, 1-10).`;

const EXAMEN_SYSTEM = `Je bent examinator van b-roll-editplannen. Toets het concept tegen de stijlgids en het onderzoek, en verbeter het:

1. Visueel rijm: past elk shot echt bij zijn buren (check de beschrijvingen/kleuren/tags), of is het een willekeurige volgorde? Herschik waar het rijm ontbreekt.
2. Tempo: kloppen de shotlengtes met de stijlgids, en versnelt het naar het slot?
3. Retentie-simulatie: loop de clip seconde voor seconde als scrollende kijker; benoem 2-3 waarschijnlijke swipe-momenten in "uitval_risicos" met fix — en pas de fix ook echt toe in de shots.
4. Overlays: dragen ze betekenis in spreektaal, of zijn het bijschriften? Schrap overlays die niets toevoegen.
5. Harde eisen: start/end binnen de bestandsduur, geen shots met bruikbaar=false, elke clip 12-30s.

Lever het volledige, verbeterde plan.`;

export async function genereerBrollPlan(campaignId: string): Promise<{ planId: string; plan: BrollPlan }> {
  const supabase = db();

  const { data: videos, error } = await supabase
    .from('videos')
    .select('id, title, duration_seconds, broll_analyse')
    .eq('campaign_id', campaignId)
    .eq('soort', 'broll')
    .is('archived_at', null)
    .order('created_at');
  if (error) throw error;
  if (!videos || videos.length < 3) {
    throw new Error(`Te weinig b-roll (${videos?.length ?? 0} shots); haal eerst de Drive-map op.`);
  }

  const { data: campagne } = await supabase
    .from('campaigns')
    .select('name, theme, platform_rules, broll_stijlgids')
    .eq('id', campaignId)
    .single();
  const stijlgids = (campagne?.broll_stijlgids as BrollStijlgids | null) ?? (await bouwStijlgids(campaignId));

  const bijgeleerd = await geleerdeKennis();

  const materiaal = videos.map((v) => {
    const a = v.broll_analyse as (BrollAnalyse & { kijk?: KijkOordeel }) | null;
    return {
      video_id: v.id,
      naam: v.title,
      duur: a?.duur ?? v.duration_seconds,
      beweging: a?.beweging,
      scenegrenzen: (a?.scenes ?? []).filter((s) => s.score > 0.3).map((s) => s.t).slice(0, 20),
      ...(a?.kijk ?? { beschrijving: 'niet bekeken', categorie: 'overig', bruikbaar: true }),
    };
  });

  const gedeeldeContext = `=== CAMPAGNE ===
${campagne?.name} (thema: ${campagne?.theme ?? 'onbekend'})
Regels: ${JSON.stringify(campagne?.platform_rules ?? {}, null, 2)}

=== STIJLGIDS (uit onderzoek naar dit genre) ===
${JSON.stringify(stijlgids, null, 2)}

=== HET MATERIAAL (${materiaal.length} shots) ===
${JSON.stringify(materiaal, null, 2)}`;

  const concept = await structuredCall({
    system: PLAN_SYSTEM + '\n\n' + EDITCRAFT + '\n\n' + EFFECTEN + '\n\n' + SPREEKTAAL + bijgeleerd,
    user: gedeeldeContext,
    schema: brollPlanSchema,
    toolName: 'lever_broll_plan',
    toolDescription: 'Lever het b-roll-editplan.',
    maxTokens: 32000,
    effort: PLAN_EFFORT,
    operation: 'broll_plan',
  });

  let plan = concept;
  try {
    plan = await structuredCall({
      system: EXAMEN_SYSTEM + '\n\n' + ONDERZOEK + '\n\n' + SPREEKTAAL + bijgeleerd,
      user: `${gedeeldeContext}

=== CONCEPTPLAN (te examineren en verbeteren) ===
${JSON.stringify(concept)}`,
      schema: brollPlanSchema,
      toolName: 'lever_broll_plan',
      toolDescription: 'Lever het volledige verbeterde b-roll-editplan.',
      maxTokens: 32000,
      effort: PLAN_EXAMEN_EFFORT,
      operation: 'broll_plan_examen',
    });
  } catch (e) {
    console.warn('[broll] examen mislukt, concept behouden:', (e as Error).message);
  }

  plan = repareerPlan(plan, materiaal);

  // Anker: het eerste b-roll-bestand — clip_plans vereist een video_id, en zo
  // lift het plan mee op alle bestaande dashboards en render_jobs.
  const { data: rij, error: planFout } = await supabase
    .from('clip_plans')
    .insert({
      video_id: videos[0].id,
      prompt_version: BROLL_PROMPT_VERSION,
      schema_version: '1.0',
      vault_snapshot: { stijlgids },
      plan,
    })
    .select('id')
    .single();
  if (planFout) throw planFout;

  return { planId: rij.id as string, plan };
}

/** Mechanische reparatie: tijden binnen het bestand, onbruikbare shots eruit, volgorde hernummerd. */
export function repareerPlan(
  plan: BrollPlan,
  materiaal: { video_id: string; duur?: number | null; bruikbaar?: boolean }[],
): BrollPlan {
  const perVideo = new Map(materiaal.map((m) => [m.video_id, m]));
  const clips = plan.clips
    .map((clip) => {
      const shots = clip.shots
        .filter((sh) => {
          const bron = perVideo.get(sh.video_id);
          return bron && bron.bruikbaar !== false;
        })
        .map((sh, i) => {
          const duur = perVideo.get(sh.video_id)?.duur ?? Number.MAX_SAFE_INTEGER;
          const start = Math.max(0, Math.min(sh.start, sh.end));
          const end = Math.min(Math.max(sh.start, sh.end), duur);
          return { ...sh, volgorde: i + 1, start, end };
        })
        .filter((sh) => sh.end - sh.start >= 0.4);
      return { ...clip, shots };
    })
    .filter((clip) => clip.shots.length >= 3)
    .sort((a, b) => b.score - a.score);
  return { vorm: 'broll', clips };
}
