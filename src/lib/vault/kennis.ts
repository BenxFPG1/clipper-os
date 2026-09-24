import { z } from 'zod';
import { db } from '../supabase';
import { structuredCall } from '../claude';

export type KennisCategorie = 'storycraft' | 'editcraft' | 'onderzoek';

/**
 * Wie de kennis afneemt. Elke afnemer krijgt alleen de categorieën die voor
 * zijn beslissing tellen: de planner heeft niets aan ffmpeg-recepten, de
 * edit-agent niets aan dramaturgie.
 */
export type KennisAfnemer = 'planner' | 'script' | 'edit' | 'broll' | 'concepten';

const CATEGORIEEN_PER_AFNEMER: Record<KennisAfnemer, KennisCategorie[]> = {
  planner: ['storycraft', 'onderzoek'],
  script: ['storycraft', 'onderzoek'],
  concepten: ['storycraft', 'onderzoek'],
  edit: ['editcraft', 'onderzoek'],
  broll: ['editcraft', 'onderzoek'],
};

/** Meer dan dit per categorie is geen kennis meer maar ruis in de prompt. */
export const MAX_KENNIS_PER_CATEGORIE = 40;

const cache = new Map<string, { tekst: string; tot: number }>();

type KennisRij = { id?: string; categorie: string; titel: string; inhoud: string; bron: string | null };

/**
 * Rijen die wel in de vault thuishoren (zichtbaar op de Vault-pagina, input
 * voor het handmatig bouwen van effecten) maar niet in een generatieprompt:
 * een effect dat de renderer niet kent is voor de planner een belofte die
 * stuk gaat, en "Effect gezien"-observaties zijn bewijs, geen regel.
 */
function isPromptRuis(rij: Pick<KennisRij, 'titel' | 'inhoud'>): boolean {
  const titel = rij.titel.toLowerCase();
  return (
    titel.startsWith('kandidaat-effect') ||
    titel.startsWith('effect gezien') ||
    rij.inhoud.includes('Nog niet in de renderer')
  );
}

/**
 * De zelflerende laag van de vault: aanvullingen die de research-agents
 * (kennis, editleraar, kijken, trends) hebben bijgeleerd. Wordt achter de
 * vaste kaders geplakt in elke plan-, examen- en scriptcall.
 *
 * Zonder `voor` komt alles mee (oude aanroepen); mét `voor` alleen de
 * categorieën die voor die afnemer tellen, zonder kandidaat-effecten, en
 * gecapt op de nieuwste rijen per categorie.
 *
 * Vijf minuten cache: de worker doet veel calls kort na elkaar en de kennis
 * verandert hooguit dagelijks.
 */
export async function geleerdeKennis(voor?: KennisAfnemer): Promise<string> {
  const sleutel = voor ?? 'alles';
  const hit = cache.get(sleutel);
  if (hit && Date.now() < hit.tot) return hit.tekst;

  const { data } = await db()
    .from('vault_kennis')
    .select('categorie, titel, inhoud, bron, created_at')
    .eq('actief', true)
    .order('created_at', { ascending: false });

  let rijen = (data ?? []) as (KennisRij & { created_at: string })[];

  if (voor) {
    const toegestaan = new Set<string>(CATEGORIEEN_PER_AFNEMER[voor]);
    const perCategorie = new Map<string, number>();
    rijen = rijen.filter((r) => {
      if (!toegestaan.has(r.categorie) || isPromptRuis(r)) return false;
      const n = perCategorie.get(r.categorie) ?? 0;
      if (n >= MAX_KENNIS_PER_CATEGORIE) return false;
      perCategorie.set(r.categorie, n + 1);
      return true;
    });
  }

  // Oudste eerst in de prompt: zo blijft de volgorde stabiel (prompt-cache)
  // en leest het als een groeiend logboek.
  rijen.reverse();

  const tekst =
    rijen.length > 0
      ? `\n\n=== BIJGELEERDE KENNIS (research-agents) ===\n` +
        rijen
          .map((k) => `[${k.categorie}] ${k.titel}\n${k.inhoud}${k.bron ? `\n(bron: ${k.bron})` : ''}`)
          .join('\n\n')
      : '';

  cache.set(sleutel, { tekst, tot: Date.now() + 5 * 60 * 1000 });
  return tekst;
}

/* ------------------------------------------------------------- dedup */

/** Lowercase, leestekens en dubbele spaties weg — zodat "Trend: Hook!" en "trend hook" gelijk zijn. */
export function normaliseerTitel(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const STOPWOORDEN = new Set(
  'de het een en of in op van voor met aan bij dan als dat die dit is zijn wordt niet te je we ons onze er dus ook nog al naar door om uit over bij tot maar want'.split(' '),
);

function woorden(tekst: string): Set<string> {
  return new Set(
    normaliseerTitel(tekst)
      .split(' ')
      .filter((w) => w.length > 2 && !STOPWOORDEN.has(w)),
  );
}

/**
 * Jaccard-achtige overlap op inhoudswoorden, gemeten t.o.v. de kortste van
 * de twee: een korte regel die volledig in een langere zit is een duplicaat,
 * ook al is de langere veel uitgebreider.
 */
export function woordOverlap(a: string, b: string): number {
  const wa = woorden(a);
  const wb = woorden(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let gedeeld = 0;
  for (const w of wa) if (wb.has(w)) gedeeld++;
  return gedeeld / Math.min(wa.size, wb.size);
}

export const OVERLAP_DREMPEL = 0.6;

export type BewaarResultaat = { bewaard: boolean; reden?: 'titel' | 'inhoud'; duplicaatVan?: string };

/**
 * Eén ingang voor alle agents die kennis wegschrijven. Dedupt vóór insert op
 * genormaliseerde titel én op woordoverlap van de inhoud met bestaande
 * actieve rijen in dezelfde categorie. Zonder dit stapelde elke run dezelfde
 * les in andere woorden op, tot de prompt meer herhaling dan kennis bevatte.
 *
 * `upsertOpTitel`: voor observaties die per definitie terugkomen (bv. "Effect
 * gezien: <slug>") één rij houden en de inhoud verversen in plaats van
 * stapelen.
 */
export async function bewaarKennis(
  rij: { categorie: KennisCategorie; titel: string; inhoud: string; bron: string | null },
  opties: { upsertOpTitel?: boolean } = {},
): Promise<BewaarResultaat> {
  const supabase = db();
  const { data: bestaand } = await supabase
    .from('vault_kennis')
    .select('id, titel, inhoud')
    .eq('categorie', rij.categorie)
    .eq('actief', true);

  const titelNorm = normaliseerTitel(rij.titel);
  const zelfdeTitel = (bestaand ?? []).find((b) => normaliseerTitel(b.titel as string) === titelNorm);

  if (zelfdeTitel) {
    if (opties.upsertOpTitel) {
      await supabase.from('vault_kennis').update({ inhoud: rij.inhoud, bron: rij.bron }).eq('id', zelfdeTitel.id);
      cache.clear();
      return { bewaard: true, reden: 'titel', duplicaatVan: zelfdeTitel.id as string };
    }
    return { bewaard: false, reden: 'titel', duplicaatVan: zelfdeTitel.id as string };
  }

  const zelfdeInhoud = (bestaand ?? []).find((b) => woordOverlap(b.inhoud as string, rij.inhoud) >= OVERLAP_DREMPEL);
  if (zelfdeInhoud) return { bewaard: false, reden: 'inhoud', duplicaatVan: zelfdeInhoud.id as string };

  const { error } = await supabase.from('vault_kennis').insert(rij);
  if (error) throw new Error(`vault_kennis insert mislukt: ${error.message}`);
  cache.clear();
  return { bewaard: true };
}

/* ------------------------------------------------------ consolidatie */

const consolidatieSchema = z.object({
  groepen: z
    .array(
      z.object({
        behoud_id: z.string().describe('Het id van de rij die blijft — de scherpste, meest toetsbare formulering.'),
        vervalt_ids: z.array(z.string()).describe('De id\'s van de rijen die hetzelfde zeggen en op inactief gaan.'),
        samengevoegde_inhoud: z
          .string()
          .nullable()
          .describe('Alleen als de bewaarde rij een concreet detail mist dat in een vervallende rij wél staat: de aangescherpte tekst. Anders null.'),
      }),
    )
    .describe('Alleen groepen van echte duplicaten. Rijen die niets met elkaar te maken hebben laat je weg.'),
});

const CONSOLIDATIE_SYSTEM = `Je ruimt de bijgeleerde kennis van een clipping-tool op. Je krijgt alle actieve rijen van één categorie, elk met een id.

Regels:
1. Twee rijen zijn een duplicaat als ze dezelfde beslissing sturen, ook in andere woorden of vanuit een andere bron. Verschillende beslissingen blijven apart, ook als het onderwerp lijkt.
2. Per groep bewaar je de scherpste formulering: concreet, toetsbaar, met getal of voorwaarde. Vage varianten vervallen.
3. Mist de bewaarde rij een concreet detail dat een vervallende wél heeft, voeg dat dan toe in samengevoegde_inhoud. Verzin niets nieuws.
4. Rijen zonder duplicaat noem je niet. Een lege lijst is een geldig antwoord.`;

/**
 * Wekelijkse opruimpas: per categorie bijna-duplicaten samenvoegen via één
 * Claude-call. De woordoverlap-dedup bij insert vangt letterlijke herhaling;
 * dit vangt wat in andere woorden hetzelfde zegt. Vervallen rijen gaan op
 * actief=false met een bron-verwijzing naar de rij die bleef, zodat niets
 * kwijt is en de Vault-pagina laat zien waarom.
 */
export async function consolideerKennis(): Promise<{
  perCategorie: Record<string, { voor: number; na: number; samengevoegd: number }>;
}> {
  const supabase = db();
  const uit: Record<string, { voor: number; na: number; samengevoegd: number }> = {};

  for (const categorie of ['storycraft', 'editcraft', 'onderzoek'] as KennisCategorie[]) {
    const { data } = await supabase
      .from('vault_kennis')
      .select('id, titel, inhoud, bron')
      .eq('categorie', categorie)
      .eq('actief', true)
      .order('created_at');
    const rijen = (data ?? []) as (KennisRij & { id: string })[];
    uit[categorie] = { voor: rijen.length, na: rijen.length, samengevoegd: 0 };
    if (rijen.length < 2) continue;

    const resultaat = await structuredCall({
      system: CONSOLIDATIE_SYSTEM,
      user: `=== CATEGORIE ${categorie} (${rijen.length} rijen) ===\n${rijen
        .map((r) => `[id ${r.id}] ${r.titel}\n${r.inhoud}${r.bron ? `\n(bron: ${r.bron})` : ''}`)
        .join('\n\n')}`,
      schema: consolidatieSchema,
      toolName: 'lever_consolidatie',
      toolDescription: 'Lever de groepen duplicaten en welke rij per groep blijft.',
      maxTokens: 12000,
      effort: 'medium',
      operation: 'kennis_consolidatie',
    });

    const bekend = new Set(rijen.map((r) => r.id));
    const alVervallen = new Set<string>();
    for (const groep of resultaat.groepen) {
      if (!bekend.has(groep.behoud_id) || alVervallen.has(groep.behoud_id)) continue;
      const vervalt = groep.vervalt_ids.filter((id) => bekend.has(id) && id !== groep.behoud_id && !alVervallen.has(id));
      if (vervalt.length === 0) continue;

      if (groep.samengevoegde_inhoud && groep.samengevoegde_inhoud.trim().length > 20) {
        await supabase.from('vault_kennis').update({ inhoud: groep.samengevoegde_inhoud.trim() }).eq('id', groep.behoud_id);
      }
      for (const id of vervalt) {
        const oud = rijen.find((r) => r.id === id);
        await supabase
          .from('vault_kennis')
          .update({
            actief: false,
            bron: `${oud?.bron ?? ''} [samengevoegd in ${groep.behoud_id} op ${new Date().toISOString().slice(0, 10)}]`.trim(),
          })
          .eq('id', id);
        alVervallen.add(id);
      }
    }
    uit[categorie].samengevoegd = alVervallen.size;
    uit[categorie].na = rijen.length - alVervallen.size;
  }

  cache.clear();
  return { perCategorie: uit };
}
