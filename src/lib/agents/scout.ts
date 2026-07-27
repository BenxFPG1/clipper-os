import { z } from 'zod';
import { structuredCall } from '../claude';
import { AGENT_EFFORT } from '../env';
import { db, logProviderUsage } from '../supabase';
import { loadVault, renderVaultForPrompt } from '../vault';
import { median } from '../tracking/performance';
import { AccountPost, Platform, getMetricsProvider } from '../tracking/provider';
import { searchYoutubeShorts } from '../tracking/youtube-discovery';

/** Hoe ver een post boven de mediaan van zijn eigen account moet zitten. */
export const OUTLIER_DREMPEL = 3;
/** Voor zoekresultaten: hoe ver boven de mediaan views-per-dag van de zoekset. */
export const DISCOVERY_DREMPEL = 2;
/** Een kandidaat-heuristiek moet over minstens zoveel verschillende accounts terugkomen. */
export const MIN_ACCOUNTS_PER_HEURISTIEK = 2;

const decodedSchema = z.object({
  posts: z.array(
    z.object({
      post_url: z.string(),
      hook_type: z.string(),
      hook_beschrijving: z.string(),
      structuur: z.string(),
      waarom_het_werkt: z.string(),
      overdraagbaar_naar_ons: z.boolean(),
    }),
  ),
  kandidaat_heuristieken: z.array(
    z.object({
      regel: z.string(),
      onderbouwing: z.string(),
      post_urls: z.array(z.string()),
      platform: z.enum(['tiktok', 'reels', 'shorts']).nullable(),
    }),
  ),
});

export type ScoutDecoded = z.infer<typeof decodedSchema>;

const SCOUT_SYSTEM = `Je bent de Scout-agent van een clipping-tool. Je krijgt posts van ANDERE accounts die bovengemiddeld presteren — deels van accounts die we volgen, deels gevonden via zoektermen op de platforms zelf. Daarnaast krijg je onze eigen vault.

Je taak is decoderen, niet bewonderen: waarom werkt deze post? Kijk naar de hook (de titel/caption verraadt meestal het instappunt), de structuur van het verhaal, en het instappunt.

Regels:
- Gebruik waar mogelijk een bestaande hook-slug uit onze vault. Past er geen, beschrijf dan de hook in eigen woorden en gebruik "nieuw:" gevolgd door een korte naam.
- overdraagbaar_naar_ons is alleen waar als wij dit met ons bronmateriaal (lange Nederlandse video's die we knippen) ook zouden kunnen.
- Stel alleen een kandidaat-heuristiek voor als je hetzelfde patroon bij meerdere posts ziet. Eén post is een anekdote, geen regel.
- Een kandidaat-heuristiek is concreet en toepasbaar tijdens het editen. Niet "maak betere hooks" maar bijvoorbeeld "toon het eindresultaat in beeld terwijl de vraag nog niet gesteld is".
- Verzin niets dat niet in de aangeleverde data staat.`;

type Outlier = AccountPost & {
  platform: Platform;
  outlier_score: number;
  views_per_dag: number | null;
  gevonden_via: string;
  accountId: string | null;
};

/**
 * Dagelijkse research-run in twee delen:
 * 1. Accounts die we volgen: uitschieters t.o.v. de mediaan van dat account.
 * 2. Zoektermen op de platforms zelf (het Sandcastles-idee): wat gaat er binnen
 *    onze niche viraal, ongeacht van wie het is. Shorts lopen gratis via yt-dlp;
 *    TikTok en Reels via de scraping-provider.
 *
 * Alles wordt gedecodeerd en bewaard; kandidaat-heuristieken worden pas actief
 * nadat de Retro-agent ze met onze eigen cijfers bevestigt (sectie 10).
 */
export async function runScoutAgent(options?: { limitPerAccount?: number }): Promise<{
  agentRunId: string;
  accountsBekeken: number;
  zoektermen: number;
  outliers: number;
  kandidaten: number;
}> {
  const supabase = db();
  const provider = getMetricsProvider();

  const [accountsRes, queriesRes] = await Promise.all([
    supabase.from('tracked_accounts').select('id, handle, platform').eq('our_own', false),
    supabase.from('search_queries').select('id, query, platform').eq('actief', true),
  ]);
  if (accountsRes.error) throw accountsRes.error;
  if (queriesRes.error) throw queriesRes.error;

  const accounts = accountsRes.data ?? [];
  const queries = queriesRes.data ?? [];

  if (accounts.length === 0 && queries.length === 0) {
    throw new Error('Niets om te onderzoeken. Voeg accounts of zoektermen toe op de Research-pagina.');
  }

  const outliers: Outlier[] = [];
  const fouten: { bron: string; error: string }[] = [];

  // Deel 1 — accounts die we volgen.
  for (const account of accounts) {
    try {
      const posts = await provider.fetchAccountPosts(
        account.handle,
        account.platform as Platform,
        options?.limitPerAccount ?? 30,
      );
      await logProviderUsage(provider.name, 'fetch_account_posts', 1, provider.costPerCallEur);

      const accountMediaan = median(posts.map((p) => p.views).filter((v): v is number => v !== null));
      if (!accountMediaan) continue;

      for (const post of posts) {
        if (post.views === null || !post.post_url) continue;
        const score = post.views / accountMediaan;
        if (score < OUTLIER_DREMPEL) continue;
        const vpd = viewsPerDag(post);
        outliers.push({
          ...post,
          handle: post.handle ?? account.handle,
          platform: account.platform as Platform,
          outlier_score: round2(score),
          views_per_dag: vpd !== null ? Math.round(vpd) : null,
          gevonden_via: `account:@${account.handle}`,
          accountId: account.id,
        });
      }

      await supabase
        .from('tracked_accounts')
        .update({ median_views_7d: Math.round(accountMediaan), updated_at: new Date().toISOString() })
        .eq('id', account.id);
    } catch (e) {
      fouten.push({ bron: `account:@${account.handle}`, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Deel 2 — zoektermen op de platforms zelf.
  for (const q of queries) {
    try {
      const platform = q.platform as Platform;
      const posts =
        platform === 'shorts'
          ? await searchYoutubeShorts(q.query, 12)
          : await provider.searchPosts(q.query, platform, 30);
      if (platform !== 'shorts') {
        await logProviderUsage(provider.name, 'search_posts', 1, provider.costPerCallEur);
      }

      // Binnen een zoekset is views-per-dag de eerlijke maat: een post van
      // gisteren met 40k views verslaat een post van twee jaar oud met 200k.
      // Geeft de bron geen posttijd (de snelle Shorts-listing filtert dan al op
      // "deze week"), dan zijn ruwe views binnen de set alsnog vergelijkbaar.
      const scored = posts
        .map((p) => ({ post: p, vpd: viewsPerDag(p), metriek: viewsPerDag(p) ?? p.views }))
        .filter((x): x is typeof x & { metriek: number } => x.metriek !== null && Boolean(x.post.post_url));
      const setMediaan = median(scored.map((x) => x.metriek));
      if (!setMediaan) continue;

      const hits = scored
        .map((x) => ({ ...x, score: x.metriek / setMediaan }))
        .filter((x) => x.score >= DISCOVERY_DREMPEL)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

      for (const hit of hits) {
        outliers.push({
          ...hit.post,
          platform,
          outlier_score: round2(hit.score),
          views_per_dag: hit.vpd !== null ? Math.round(hit.vpd) : null,
          gevonden_via: `zoekterm:${q.query}`,
          accountId: null,
        });
      }
    } catch (e) {
      fouten.push({ bron: `zoekterm:${q.query}`, error: e instanceof Error ? e.message : String(e) });
    }
  }

  outliers.sort((a, b) => b.outlier_score - a.outlier_score);
  const teDecoderen = dedupeByUrl(outliers).slice(0, 25);

  // Decoderen is een verrijking, geen voorwaarde: als de Claude-call faalt
  // (bijvoorbeeld op credits), bewaren we de vondsten alsnog en decoderen we
  // een volgende run. Research-data mag niet verdwijnen omdat het LLM hapert.
  let decoded: ScoutDecoded = { posts: [], kandidaat_heuristieken: [] };
  if (teDecoderen.length > 0) {
    try {
      decoded = await decodeer(teDecoderen);
    } catch (e) {
      fouten.push({ bron: 'decodering', error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Vondsten bewaren, zodat elke heuristiek terug te voeren is op echte posts.
  for (const outlier of teDecoderen) {
    const analyse = decoded.posts.find((p) => p.post_url === outlier.post_url);
    const { error: upsertError } = await supabase.from('scout_finds').upsert(
      {
        tracked_account_id: outlier.accountId,
        handle: outlier.handle ?? 'onbekend',
        platform: outlier.platform,
        post_url: outlier.post_url,
        posted_at: outlier.posted_at,
        views: outlier.views,
        likes: outlier.likes,
        comments: outlier.comments,
        outlier_score: outlier.outlier_score,
        views_per_dag: outlier.views_per_dag,
        gevonden_via: outlier.gevonden_via,
        caption: outlier.caption,
        decoded: analyse ?? null,
      },
      { onConflict: 'post_url' },
    );
    if (upsertError) {
      fouten.push({ bron: `opslaan:${outlier.post_url}`, error: upsertError.message });
    }
  }

  const kandidaten = await schrijfKandidaten(decoded, teDecoderen);

  const { data: run, error: runError } = await supabase
    .from('agent_runs')
    .insert({
      agent: 'scout',
      input_summary: {
        accounts: accounts.length,
        zoektermen: queries.length,
        posts_bekeken: outliers.length,
        gedecodeerd: teDecoderen.length,
        fouten,
      },
      proposal: decoded,
      status: 'auto',
    })
    .select()
    .single();
  if (runError) throw runError;

  return {
    agentRunId: run.id,
    accountsBekeken: accounts.length,
    zoektermen: queries.length,
    outliers: outliers.length,
    kandidaten,
  };
}

async function decodeer(teDecoderen: Outlier[]): Promise<ScoutDecoded> {
  const vault = await loadVault();
  return structuredCall({
    system: SCOUT_SYSTEM,
    user: `=== ONZE VAULT ===\n${renderVaultForPrompt(vault)}\n\n=== UITSCHIETERS OP DE PLATFORMS ===\n${JSON.stringify(
      teDecoderen.map((o) => ({
        post_url: o.post_url,
        account: o.handle,
        platform: o.platform,
        gevonden_via: o.gevonden_via,
        views: o.views,
        views_per_dag: o.views_per_dag,
        likes: o.likes,
        comments: o.comments,
        outlier_score: o.outlier_score,
        titel_of_caption: o.caption,
      })),
      null,
      2,
    )}`,
    schema: decodedSchema,
    toolName: 'lever_scout_analyse',
    toolDescription: 'Lever de decodering van deze posts plus kandidaat-heuristieken.',
    maxTokens: 16000,
    effort: AGENT_EFFORT,
    operation: 'scout_agent',
  });
}

function viewsPerDag(post: AccountPost): number | null {
  if (post.views === null || !post.posted_at) return null;
  const dagen = Math.max(1, (Date.now() - new Date(post.posted_at).getTime()) / (24 * 3600 * 1000));
  return post.views / dagen;
}

function dedupeByUrl(outliers: Outlier[]): Outlier[] {
  const seen = new Set<string>();
  return outliers.filter((o) => {
    if (seen.has(o.post_url)) return false;
    seen.add(o.post_url);
    return true;
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Schrijft kandidaat-heuristieken weg met een evidence_score van
 * aantal posts x aantal verschillende accounts. Een patroon dat bij één account
 * werkt kan toeval of format-specifiek zijn; over meerdere accounts wordt het
 * interessant.
 */
async function schrijfKandidaten(
  decoded: ScoutDecoded,
  outliers: { post_url: string; handle: string | null }[],
): Promise<number> {
  const supabase = db();
  const handleVanPost = new Map(outliers.map((o) => [o.post_url, o.handle ?? 'onbekend']));

  const { data: bestaand } = await supabase.from('vault_heuristics').select('rule');
  const bekend = new Set((bestaand ?? []).map((r) => r.rule));

  let geschreven = 0;
  for (const kandidaat of decoded.kandidaat_heuristieken) {
    const accounts = new Set(
      kandidaat.post_urls.map((url) => handleVanPost.get(url)).filter((h): h is string => Boolean(h)),
    );
    if (accounts.size < MIN_ACCOUNTS_PER_HEURISTIEK) continue;
    if (bekend.has(kandidaat.regel)) continue;

    const { error } = await supabase.from('vault_heuristics').insert({
      rule: kandidaat.regel,
      source: 'scout_agent',
      status: 'candidate',
      evidence_score: kandidaat.post_urls.length * accounts.size,
      platform: kandidaat.platform,
    });
    if (!error) geschreven++;
  }

  return geschreven;
}
