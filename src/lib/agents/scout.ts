import { z } from 'zod';
import { structuredCall } from '../claude';
import { db, logProviderUsage } from '../supabase';
import { loadVault, renderVaultForPrompt } from '../vault';
import { median } from '../tracking/performance';
import { AccountPost, Platform, getMetricsProvider } from '../tracking/provider';

/** Hoe ver een post boven de mediaan van dat account moet zitten om interessant te zijn. */
export const OUTLIER_DREMPEL = 3;
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

const SCOUT_SYSTEM = `Je bent de Scout-agent van een clipping-tool. Je krijgt posts van ANDERE accounts die bovengemiddeld presteren, plus onze eigen vault.

Je taak is decoderen, niet bewonderen: waarom werkt deze post? Kijk naar de hook (de eerste 1,5 seconde), de structuur van het verhaal, en het instappunt.

Regels:
- Gebruik waar mogelijk een bestaande hook-slug uit onze vault. Past er geen, beschrijf dan de hook in eigen woorden en gebruik "nieuw:" gevolgd door een korte naam.
- overdraagbaar_naar_ons is alleen waar als wij dit met ons bronmateriaal (lange Nederlandse video's die we knippen) ook zouden kunnen.
- Stel alleen een kandidaat-heuristiek voor als je hetzelfde patroon bij meerdere posts ziet. Eén post is een anekdote, geen regel.
- Een kandidaat-heuristiek is concreet en toepasbaar tijdens het editen. Niet "maak betere hooks" maar bijvoorbeeld "toon het eindresultaat in beeld terwijl de vraag nog niet gesteld is".
- Verzin niets dat niet in de aangeleverde data staat.`;

/**
 * Dagelijkse scout-run. Haalt recente posts op van de accounts die we volgen
 * (concurrent-clippers en de creator zelf), zoekt de uitschieters t.o.v. de
 * mediaan van dat account, laat Claude ze decoderen, en schrijft de uitkomst weg
 * als kandidaat-heuristieken.
 *
 * Kandidaten worden bewust NIET actief: de Retro-agent moet ze eerst met onze
 * eigen cijfers bevestigen (sectie 10).
 */
export async function runScoutAgent(options?: { limitPerAccount?: number }): Promise<{
  agentRunId: string;
  accountsBekeken: number;
  outliers: number;
  kandidaten: number;
}> {
  const supabase = db();
  const provider = getMetricsProvider();

  const { data: accounts, error } = await supabase
    .from('tracked_accounts')
    .select('id, handle, platform')
    .eq('our_own', false);
  if (error) throw error;

  if (!accounts?.length) {
    throw new Error(
      'Geen accounts om te volgen. Voeg concurrenten of de creator toe via POST /api/tracked-accounts.',
    );
  }

  const outliers: (AccountPost & { handle: string; platform: Platform; outlier_score: number; accountId: string })[] =
    [];
  const fouten: { handle: string; error: string }[] = [];

  for (const account of accounts) {
    try {
      const posts = await provider.fetchAccountPosts(
        account.handle,
        account.platform as Platform,
        options?.limitPerAccount ?? 30,
      );
      await logProviderUsage(provider.name, 'fetch_account_posts', 1, provider.costPerCallEur);

      const viewCounts = posts.map((p) => p.views).filter((v): v is number => v !== null);
      const accountMediaan = median(viewCounts);
      if (!accountMediaan) continue;

      // De mediaan van het account zelf is de meetlat: een account met 2M views
      // per post heeft een andere normaal dan eentje met 20k.
      for (const post of posts) {
        if (post.views === null || !post.post_url) continue;
        const score = post.views / accountMediaan;
        if (score < OUTLIER_DREMPEL) continue;
        outliers.push({
          ...post,
          handle: account.handle,
          platform: account.platform as Platform,
          outlier_score: Math.round(score * 100) / 100,
          accountId: account.id,
        });
      }

      await supabase
        .from('tracked_accounts')
        .update({ median_views_7d: Math.round(accountMediaan), updated_at: new Date().toISOString() })
        .eq('id', account.id);
    } catch (e) {
      fouten.push({ handle: account.handle, error: e instanceof Error ? e.message : String(e) });
    }
  }

  outliers.sort((a, b) => b.outlier_score - a.outlier_score);
  const teDecoderen = outliers.slice(0, 25);

  let decoded: ScoutDecoded = { posts: [], kandidaat_heuristieken: [] };
  if (teDecoderen.length > 0) {
    const vault = await loadVault();
    decoded = await structuredCall({
      system: SCOUT_SYSTEM,
      user: `=== ONZE VAULT ===\n${renderVaultForPrompt(vault)}\n\n=== UITSCHIETERS BIJ ANDERE ACCOUNTS ===\n${JSON.stringify(
        teDecoderen.map((o) => ({
          post_url: o.post_url,
          account: o.handle,
          platform: o.platform,
          views: o.views,
          likes: o.likes,
          comments: o.comments,
          outlier_score: o.outlier_score,
          caption: o.caption,
        })),
        null,
        2,
      )}`,
      schema: decodedSchema,
      toolName: 'lever_scout_analyse',
      toolDescription: 'Lever de decodering van deze posts plus kandidaat-heuristieken.',
      maxTokens: 16000,
      effort: 'high',
      operation: 'scout_agent',
    });
  }

  // Vondsten bewaren, zodat elke heuristiek terug te voeren is op echte posts.
  for (const outlier of teDecoderen) {
    const analyse = decoded.posts.find((p) => p.post_url === outlier.post_url);
    await supabase.from('scout_finds').upsert(
      {
        tracked_account_id: outlier.accountId,
        handle: outlier.handle,
        platform: outlier.platform,
        post_url: outlier.post_url,
        posted_at: outlier.posted_at,
        views: outlier.views,
        likes: outlier.likes,
        comments: outlier.comments,
        outlier_score: outlier.outlier_score,
        caption: outlier.caption,
        decoded: analyse ?? null,
      },
      { onConflict: 'post_url' },
    );
  }

  const kandidaten = await schrijfKandidaten(decoded, teDecoderen);

  const { data: run, error: runError } = await supabase
    .from('agent_runs')
    .insert({
      agent: 'scout',
      input_summary: {
        accounts: accounts.length,
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
    outliers: outliers.length,
    kandidaten,
  };
}

/**
 * Schrijft kandidaat-heuristieken weg met een evidence_score van
 * aantal posts x aantal verschillende accounts. Een patroon dat bij één account
 * werkt kan toeval of format-specifiek zijn; over meerdere accounts wordt het
 * interessant.
 */
async function schrijfKandidaten(
  decoded: ScoutDecoded,
  outliers: { post_url: string; handle: string }[],
): Promise<number> {
  const supabase = db();
  const handleVanPost = new Map(outliers.map((o) => [o.post_url, o.handle]));

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
