import { z } from 'zod';
import { structuredCall } from '../claude';
import { AGENT_EFFORT } from '../env';
import { db } from '../supabase';
import { loadVault, renderVaultForPrompt } from '../vault';

/**
 * De trends-agent: de "wat werkt er nú"-laag bovenop alles wat de scout
 * verzamelt.
 *
 * De scout decodeert losse vondsten, maar niemand keek ooit over het geheel
 * heen: honderdvijftig gedecodeerde posts bleven honderdvijftig losse rijen.
 * Deze agent doet dagelijks wat een menselijke strateeg hooguit wekelijks zou
 * doen — alles van de afgelopen periode naast elkaar leggen en de patronen
 * benoemen:
 *
 * 1. Mechanisch (geen model, geen mening): hook- en structuur-rankings over
 *    alle gedecodeerde vondsten, per thema en platform, met views-per-dag als
 *    eerlijke maat. Dit zijn harde tellingen die de planner letterlijk mee
 *    kan krijgen.
 * 2. Eén Claude-call voor het verhaal: wat betekenen deze rankings, wat
 *    veranderde er t.o.v. het vorige rapport (de diff is waar het leren zit),
 *    welke zoektermen missen we, en hooguit twee lessen die concreet genoeg
 *    zijn voor de vault.
 *
 * Wat in vault_kennis landt gaat automatisch mee in élke plan-, script- en
 * b-roll-call (geleerdeKennis) — het rapport is dus geen dashboard om naar te
 * kijken maar brandstof die direct doorwerkt in wat de tool maakt.
 */

export const TREND_PERIODE_DAGEN = Number(process.env.TREND_PERIODE_DAGEN ?? 30);
/** Onder dit aantal gedecodeerde vondsten zegt een ranking niets. */
export const MIN_VONDSTEN = 15;
/** Plafond op actieve zoektermen: elke term kost per run zoekcredits op drie platforms. */
export const MAX_ZOEKTERMEN = 14;

export type TrendVondst = {
  post_url: string;
  handle: string;
  platform: string;
  theme: string | null;
  views_per_dag: number | null;
  decoded: {
    hook_type?: string;
    structuur?: string;
    waarom_het_werkt?: string;
    overdraagbaar_naar_ons?: boolean;
  } | null;
};

export type TrendRij = {
  sleutel: string;
  aantal: number;
  accounts: number;
  overdraagbaar: number;
  mediaanViewsPerDag: number | null;
  platforms: Record<string, number>;
  themas: Record<string, number>;
  voorbeelden: { post_url: string; handle: string; waarom: string }[];
};

export type TrendRankings = {
  periodeDagen: number;
  vondsten: number;
  hooks: TrendRij[];
  structuren: TrendRij[];
};

/**
 * Puur en testbaar: telt gedecodeerde vondsten bij elkaar tot rankings.
 * Gesorteerd op (verschillende accounts, aantal posts, mediaan views/dag) —
 * een patroon dat bij vijf accounts terugkomt is sterker bewijs dan één
 * account dat vijf keer hetzelfde deed, precies zoals de scout dat ook al
 * hanteert voor kandidaat-heuristieken.
 */
export function aggregeerVondsten(finds: TrendVondst[], periodeDagen = TREND_PERIODE_DAGEN): TrendRankings {
  const bouw = (veld: 'hook_type' | 'structuur'): TrendRij[] => {
    const groepen = new Map<string, TrendVondst[]>();
    for (const f of finds) {
      const sleutel = f.decoded?.[veld]?.trim();
      if (!sleutel) continue;
      const lijst = groepen.get(sleutel) ?? [];
      lijst.push(f);
      groepen.set(sleutel, lijst);
    }

    return [...groepen.entries()]
      .map(([sleutel, lijst]) => {
        const vpds = lijst
          .map((f) => f.views_per_dag)
          .filter((v): v is number => v !== null)
          .sort((a, b) => a - b);
        const tel = (kies: (f: TrendVondst) => string | null) => {
          const uit: Record<string, number> = {};
          for (const f of lijst) {
            const k = kies(f);
            if (k) uit[k] = (uit[k] ?? 0) + 1;
          }
          return uit;
        };
        return {
          sleutel,
          aantal: lijst.length,
          accounts: new Set(lijst.map((f) => f.handle.toLowerCase())).size,
          overdraagbaar: lijst.filter((f) => f.decoded?.overdraagbaar_naar_ons).length,
          mediaanViewsPerDag: vpds.length > 0 ? Math.round(vpds[Math.floor(vpds.length / 2)]) : null,
          platforms: tel((f) => f.platform),
          themas: tel((f) => f.theme),
          voorbeelden: [...lijst]
            .sort((a, b) => (b.views_per_dag ?? 0) - (a.views_per_dag ?? 0))
            .slice(0, 3)
            .map((f) => ({
              post_url: f.post_url,
              handle: f.handle,
              waarom: (f.decoded?.waarom_het_werkt ?? '').slice(0, 200),
            })),
        };
      })
      .sort(
        (a, b) =>
          b.accounts - a.accounts ||
          b.aantal - a.aantal ||
          (b.mediaanViewsPerDag ?? 0) - (a.mediaanViewsPerDag ?? 0),
      );
  };

  return {
    periodeDagen,
    vondsten: finds.filter((f) => f.decoded?.hook_type || f.decoded?.structuur).length,
    hooks: bouw('hook_type'),
    structuren: bouw('structuur'),
  };
}

const rapportSchema = z.object({
  rapport: z
    .string()
    .describe('Leesbaar rapport in het Nederlands: wat werkt er nu, per thema waar relevant. Concreet, geen managementtaal.'),
  veranderingen: z
    .string()
    .describe('Wat is er veranderd t.o.v. het vorige rapport — de diff is waar het leren zit. Leeg als er geen vorig rapport is.'),
  nieuwe_zoektermen: z
    .array(
      z.object({
        query: z.string(),
        platform: z.enum(['tiktok', 'reels', 'shorts']),
        theme: z.string().nullable(),
      }),
    )
    .max(3)
    .describe('Zoektermen die een gat in onze dekking vullen. Alleen als de rankings een blinde vlek laten zien.'),
  vault_lessen: z
    .array(z.object({ titel: z.string().max(80), inhoud: z.string() }))
    .max(2)
    .describe('Hooguit twee lessen die een concrete beslissing veranderen. Leeg is een geldige uitkomst.'),
});

const SYSTEM = `Je bent de trends-agent van een clipping-tool. Je krijgt harde tellingen over wat er de afgelopen periode op de platforms werkte (hook- en structuur-rankings uit gedecodeerde uitschieters), onze vault, en het vorige trendrapport.

Regels:
1. Het rapport gaat over wat de DATA zegt, niet wat je over social media weet. Elke bewering moet terug te voeren zijn op de rankings of de voorbeelden.
2. De diff met het vorige rapport is het belangrijkste onderdeel: wat stijgt, wat zakt, wat is nieuw. Zonder vorig rapport beschrijf je alleen het nu.
3. Let op "overdraagbaar": een patroon dat wij met ons bronmateriaal (lange Nederlandse video's knippen) niet kúnnen, hoort niet in de aanbevelingen.
4. Nieuwe zoektermen alleen bij een echte blinde vlek — Nederlandstalig waar dat past bij onze niche.
5. Een vault-les moet een concrete beslissing veranderen ("open financiële clips met het bedrag in beeld vóór de vraag" wel; "speel in op trends" niet). Wat al in de vault of eerdere lessen staat, stel je niet opnieuw voor. Liever nul lessen dan een vage.`;

export async function runTrendsAgent(): Promise<{
  vondsten: number;
  hooks: number;
  structuren: number;
  zoektermen: number;
  lessen: number;
  rapport: string;
}> {
  const supabase = db();
  const sinds = new Date(Date.now() - TREND_PERIODE_DAGEN * 24 * 3600 * 1000).toISOString();

  const { data: finds, error } = await supabase
    .from('scout_finds')
    .select('post_url, handle, platform, theme, views_per_dag, decoded')
    .gte('created_at', sinds)
    .not('decoded', 'is', null);
  if (error) throw error;

  const rankings = aggregeerVondsten((finds ?? []) as TrendVondst[]);
  if (rankings.vondsten < MIN_VONDSTEN) {
    throw new Error(
      `Te weinig gedecodeerde vondsten (${rankings.vondsten} < ${MIN_VONDSTEN}) voor een rapport dat iets zegt.`,
    );
  }

  const { data: vorige } = await supabase
    .from('trend_rapporten')
    .select('rapport, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const vault = await loadVault();
  const resultaat = await structuredCall({
    system: SYSTEM,
    user: `=== ONZE VAULT ===
${renderVaultForPrompt(vault)}

=== RANKINGS (${rankings.periodeDagen} dagen, ${rankings.vondsten} gedecodeerde vondsten) ===
HOOKS:
${JSON.stringify(rankings.hooks.slice(0, 12), null, 1)}

STRUCTUREN:
${JSON.stringify(rankings.structuren.slice(0, 12), null, 1)}

=== VORIG RAPPORT (${vorige ? new Date(vorige.created_at as string).toLocaleDateString('nl-NL') : 'geen'}) ===
${(vorige?.rapport as string | undefined) ?? '—'}`,
    schema: rapportSchema,
    toolName: 'lever_trendrapport',
    toolDescription: 'Lever het trendrapport, de diff, eventuele zoektermen en vault-lessen.',
    maxTokens: 12000,
    effort: AGENT_EFFORT,
    operation: 'trends_agent',
  });

  await supabase.from('trend_rapporten').insert({
    periode_dagen: TREND_PERIODE_DAGEN,
    rankings,
    rapport: resultaat.rapport,
    veranderingen: resultaat.veranderingen || null,
  });

  // Zoektermen aanvullen, met plafond: elke actieve term kost per scout-run
  // zoekcredits op meerdere platforms, dus de lijst mag niet stil volgroeien.
  let zoektermen = 0;
  const { count: actief } = await supabase
    .from('search_queries')
    .select('*', { count: 'exact', head: true })
    .eq('actief', true);
  let ruimte = Math.max(0, MAX_ZOEKTERMEN - (actief ?? 0));
  for (const term of resultaat.nieuwe_zoektermen) {
    if (ruimte === 0) break;
    const { error: insErr } = await supabase
      .from('search_queries')
      .insert({ query: term.query.toLowerCase().trim(), platform: term.platform, theme: term.theme });
    if (!insErr) {
      zoektermen++;
      ruimte--;
    }
  }

  // Lessen naar de vault — daarmee werken ze direct door in elke plan/script-
  // call. Dedup op titel zodat een herhaald inzicht niet elke week opnieuw landt.
  let lessen = 0;
  const { data: bestaand } = await supabase.from('vault_kennis').select('titel');
  const bekend = new Set((bestaand ?? []).map((k) => (k.titel as string).toLowerCase()));
  for (const les of resultaat.vault_lessen) {
    const titel = `Trend: ${les.titel}`;
    if (bekend.has(titel.toLowerCase())) continue;
    const { error: insErr } = await supabase.from('vault_kennis').insert({
      categorie: 'onderzoek',
      titel,
      inhoud: les.inhoud,
      bron: `Trendrapport ${new Date().toLocaleDateString('nl-NL')} (${rankings.vondsten} vondsten, ${TREND_PERIODE_DAGEN}d)`,
    });
    if (!insErr) lessen++;
  }

  await supabase.from('agent_runs').insert({
    agent: 'trends',
    input_summary: { vondsten: rankings.vondsten, hooks: rankings.hooks.length, structuren: rankings.structuren.length },
    proposal: resultaat,
    status: 'auto',
    decided_by: 'auto',
  });

  return {
    vondsten: rankings.vondsten,
    hooks: rankings.hooks.length,
    structuren: rankings.structuren.length,
    zoektermen,
    lessen,
    rapport: resultaat.rapport,
  };
}
