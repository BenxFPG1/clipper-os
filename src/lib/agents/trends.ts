import { z } from 'zod';
import { structuredCall } from '../claude';
import { AGENT_EFFORT } from '../env';
import { db } from '../supabase';
import { loadVault, renderVaultForPrompt } from '../vault';
import { bewaarKennis } from '../vault/kennis';

/**
 * De trends-agent: de "wat werkt er nú"-laag bovenop alles wat de scout
 * verzamelt.
 *
 * De scout decodeert losse vondsten, maar niemand keek ooit over het geheel
 * heen: honderdvijftig gedecodeerde posts bleven honderdvijftig losse rijen.
 * Deze agent doet — zodra er genoeg verse gedecodeerde vondsten zijn — wat
 * een menselijke strateeg hooguit wekelijks zou doen: alles van de afgelopen
 * periode naast elkaar leggen en de patronen benoemen.
 *
 * 1. Mechanisch (geen model, geen mening): hook- en structuur-rankings over
 *    alle gedecodeerde vondsten, per thema en platform, met views-per-dag als
 *    eerlijke maat, plus de diff met de vorige rankings. Dit zijn harde
 *    tellingen die de planner letterlijk meekrijgt (renderVaultForPrompt).
 * 2. Eén Claude-call voor het verhaal: wat betekenen deze rankings en de
 *    verschuivingen, welke zoektermen missen we, en hooguit twee lessen die
 *    concreet genoeg zijn voor de vault.
 *
 * Wat in vault_kennis landt gaat automatisch mee in élke plan- en script-call
 * (geleerdeKennis) — het rapport is dus geen dashboard om naar te kijken
 * maar brandstof die direct doorwerkt in wat de tool maakt.
 */

export const TREND_PERIODE_DAGEN = Number(process.env.TREND_PERIODE_DAGEN ?? 30);
/** Onder dit aantal gedecodeerde vondsten zegt een ranking niets. */
export const MIN_VONDSTEN = 15;
/**
 * Pas een nieuw rapport als er zoveel nieuwe gedecodeerde vondsten zijn sinds
 * het vorige: twee keer per dag hetzelfde venster herkauwen levert dezelfde
 * rankings en een derde variant van dezelfde les op.
 */
export const MIN_NIEUWE_VONDSTEN = 5;
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

export type TrendVerschil = {
  sleutel: string;
  soort: 'hook' | 'structuur';
  positieOud: number | null;
  positieNieuw: number | null;
  aantalOud: number;
  aantalNieuw: number;
  accountsOud: number;
  accountsNieuw: number;
  status: 'nieuw' | 'verdwenen' | 'stijgt' | 'zakt' | 'gelijk';
};

/**
 * Mechanische diff tussen twee rankings. Dit is wat het model vroeger uit
 * twee stukken proza moest raden; nu krijgt hij een tabel en hoeft hij alleen
 * te duiden. Puur en testbaar.
 */
export function vergelijkRankings(oud: TrendRankings | null, nieuw: TrendRankings): TrendVerschil[] {
  const uit: TrendVerschil[] = [];
  for (const soort of ['hook', 'structuur'] as const) {
    const lijstOud = oud ? (soort === 'hook' ? oud.hooks : oud.structuren) : [];
    const lijstNieuw = soort === 'hook' ? nieuw.hooks : nieuw.structuren;
    const oudMap = new Map(lijstOud.map((r, i) => [r.sleutel, { r, i }]));
    const nieuwMap = new Map(lijstNieuw.map((r, i) => [r.sleutel, { r, i }]));

    for (const sleutel of new Set([...oudMap.keys(), ...nieuwMap.keys()])) {
      const o = oudMap.get(sleutel);
      const n = nieuwMap.get(sleutel);
      let status: TrendVerschil['status'];
      if (!o) status = 'nieuw';
      else if (!n) status = 'verdwenen';
      else if (n.i < o.i || n.r.accounts > o.r.accounts) status = 'stijgt';
      else if (n.i > o.i || n.r.accounts < o.r.accounts) status = 'zakt';
      else status = 'gelijk';
      uit.push({
        sleutel,
        soort,
        positieOud: o ? o.i + 1 : null,
        positieNieuw: n ? n.i + 1 : null,
        aantalOud: o?.r.aantal ?? 0,
        aantalNieuw: n?.r.aantal ?? 0,
        accountsOud: o?.r.accounts ?? 0,
        accountsNieuw: n?.r.accounts ?? 0,
        status,
      });
    }
  }
  // Wat beweegt eerst; wat gelijk bleef onderaan.
  const rang: Record<TrendVerschil['status'], number> = { nieuw: 0, stijgt: 1, zakt: 2, verdwenen: 3, gelijk: 4 };
  return uit.sort((a, b) => rang[a.status] - rang[b.status] || b.accountsNieuw - a.accountsNieuw);
}

function renderDiff(verschillen: TrendVerschil[]): string {
  const bewegend = verschillen.filter((v) => v.status !== 'gelijk');
  if (bewegend.length === 0) return 'Geen verschuivingen t.o.v. het vorige rapport.';
  return [
    'soort | sleutel | status | positie oud→nieuw | posts oud→nieuw | accounts oud→nieuw',
    ...bewegend
      .slice(0, 30)
      .map(
        (v) =>
          `${v.soort} | ${v.sleutel} | ${v.status} | ${v.positieOud ?? '—'}→${v.positieNieuw ?? '—'} | ${v.aantalOud}→${v.aantalNieuw} | ${v.accountsOud}→${v.accountsNieuw}`,
      ),
  ].join('\n');
}

const rapportSchema = z.object({
  rapport: z
    .string()
    .describe('Leesbaar rapport in het Nederlands: wat werkt er nu, per thema waar relevant. Concreet, geen managementtaal.'),
  veranderingen: z
    .string()
    .describe('Duiding van de diff-tabel: wat stijgt, wat zakt, wat is nieuw, en wat dat betekent voor wat we maken. Leeg als er geen vorig rapport is.'),
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

const SYSTEM = `Je bent de trends-agent van een clipping-tool. Je krijgt harde tellingen over wat er de afgelopen periode op de platforms werkte (hook- en structuur-rankings uit gedecodeerde uitschieters), een mechanisch berekende diff-tabel t.o.v. de vorige rankings, onze vault, en het vorige trendrapport.

Regels:
1. Het rapport gaat over wat de DATA zegt, niet wat je over social media weet. Elke bewering moet terug te voeren zijn op de rankings, de diff-tabel of de voorbeelden.
2. De diff-tabel is het belangrijkste onderdeel: duid wat stijgt, zakt, nieuw is of verdwijnt — en let op de "accounts"-kolom, want een patroon dat bij meer verschillende accounts terugkomt is sterker bewijs dan meer posts van één account. Zonder vorig rapport beschrijf je alleen het nu.
3. Sleutels die met "nieuw:" beginnen zijn patronen die nog geen vault-slug hebben; komt zo'n sleutel bij meerdere accounts terug, benoem dat dan expliciet als mogelijk nieuw archetype.
4. Let op "overdraagbaar": een patroon dat wij met ons bronmateriaal (lange Nederlandse video's knippen) niet kúnnen, hoort niet in de aanbevelingen.
5. Nieuwe zoektermen alleen bij een echte blinde vlek — Nederlandstalig waar dat past bij onze niche.
6. Een vault-les moet een concrete beslissing veranderen ("open financiële clips met het bedrag in beeld vóór de vraag" wel; "speel in op trends" niet). Wat al in de vault of eerdere lessen staat, stel je niet opnieuw voor. Liever nul lessen dan een vage.`;

export type TrendsResultaat = {
  vondsten: number;
  hooks: number;
  structuren: number;
  zoektermen: number;
  lessen: number;
  rapport: string;
  /** Waarom er (nog) geen rapport gemaakt is; null als de run gewoon liep. */
  overgeslagen: string | null;
};

export async function runTrendsAgent(): Promise<TrendsResultaat> {
  const supabase = db();
  const sinds = new Date(Date.now() - TREND_PERIODE_DAGEN * 24 * 3600 * 1000).toISOString();

  const { data: finds, error } = await supabase
    .from('scout_finds')
    .select('post_url, handle, platform, theme, views_per_dag, decoded, created_at')
    .gte('created_at', sinds)
    .not('decoded', 'is', null)
    .eq('is_basislijn', false);
  if (error) throw error;

  const { data: vorige } = await supabase
    .from('trend_rapporten')
    .select('rapport, rankings, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const rankings = aggregeerVondsten((finds ?? []) as TrendVondst[]);
  const stil = (reden: string): TrendsResultaat => ({
    vondsten: rankings.vondsten,
    hooks: rankings.hooks.length,
    structuren: rankings.structuren.length,
    zoektermen: 0,
    lessen: 0,
    rapport: '',
    overgeslagen: reden,
  });

  // Te weinig data of te weinig nieuws: stil succes, geen exit 1. Een rapport
  // dat niets zegt is erger dan geen rapport.
  if (rankings.vondsten < MIN_VONDSTEN) {
    return stil(`te weinig gedecodeerde vondsten (${rankings.vondsten} < ${MIN_VONDSTEN})`);
  }
  if (vorige?.created_at) {
    const nieuwSinds = (finds ?? []).filter((f) => (f.created_at as string) > (vorige.created_at as string)).length;
    if (nieuwSinds < MIN_NIEUWE_VONDSTEN) {
      return stil(`${nieuwSinds} nieuwe vondst(en) sinds het vorige rapport (< ${MIN_NIEUWE_VONDSTEN})`);
    }
  }

  const vorigeRankings = (vorige?.rankings as TrendRankings | null) ?? null;
  const verschillen = vergelijkRankings(vorigeRankings, rankings);

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

=== DIFF T.O.V. VORIGE RANKINGS (${vorige ? new Date(vorige.created_at as string).toLocaleDateString('nl-NL') : 'geen vorig rapport'}) ===
${vorigeRankings ? renderDiff(verschillen) : '—'}

=== VORIG RAPPORT ===
${(vorige?.rapport as string | undefined) ?? '—'}`,
    schema: rapportSchema,
    toolName: 'lever_trendrapport',
    toolDescription: 'Lever het trendrapport, de duiding van de diff, eventuele zoektermen en vault-lessen.',
    maxTokens: 12000,
    effort: AGENT_EFFORT,
    operation: 'trends_agent',
  });

  const { error: rapportFout } = await supabase.from('trend_rapporten').insert({
    periode_dagen: TREND_PERIODE_DAGEN,
    rankings,
    rapport: resultaat.rapport,
    veranderingen: resultaat.veranderingen || null,
  });
  if (rapportFout) throw new Error(`trend_rapporten insert mislukt: ${rapportFout.message}`);

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
  // call. bewaarKennis dedupt op titel én inhoud, zodat een herhaald inzicht
  // in andere woorden niet opnieuw landt.
  let lessen = 0;
  for (const les of resultaat.vault_lessen) {
    const r = await bewaarKennis({
      categorie: 'onderzoek',
      titel: `Trend: ${les.titel}`,
      inhoud: les.inhoud,
      bron: `Trendrapport ${new Date().toLocaleDateString('nl-NL')} (${rankings.vondsten} vondsten, ${TREND_PERIODE_DAGEN}d)`,
    });
    if (r.bewaard) lessen++;
  }

  await supabase.from('agent_runs').insert({
    agent: 'trends',
    input_summary: {
      vondsten: rankings.vondsten,
      hooks: rankings.hooks.length,
      structuren: rankings.structuren.length,
      verschuivingen: verschillen.filter((v) => v.status !== 'gelijk').length,
    },
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
    overgeslagen: null,
  };
}
