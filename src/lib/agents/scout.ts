import { z } from 'zod';
import { structuredCall } from '../claude';
import { AGENT_EFFORT } from '../env';
import { db, logProviderUsage } from '../supabase';
import { Theme, buildClassifyPrompt, loadThemes, loadVault, renderVaultForPrompt } from '../vault';
import { median } from '../tracking/performance';
import { AccountPost, Platform, getMetricsProvider } from '../tracking/provider';
import { searchYoutubeShorts } from '../tracking/youtube-discovery';

/** Hoe ver een post boven de mediaan van zijn eigen account moet zitten. */
export const OUTLIER_DREMPEL = 3;
/** Voor zoekresultaten: hoe ver boven de mediaan views-per-dag van de zoekset. */
export const DISCOVERY_DREMPEL = 2;
/** Onder deze grenzen is een resultatenset te dun om iets uit af te leiden. */
export const MIN_SET_OMVANG = 5;
export const MIN_MEDIAAN = 500;
/** Bovengrens tegen scheve verhoudingen; alles hierboven is toch "enorm". */
export const MAX_OUTLIER_SCORE = 100;

/** Een kandidaat-heuristiek moet over minstens zoveel verschillende accounts terugkomen. */
export const MIN_ACCOUNTS_PER_HEURISTIEK = 2;
/**
 * Hoeveel externe accounts we maximaal blijven volgen. Elk gevolgd account
 * kost één credit per scout-run, dus dit is direct een budgetknop.
 */
export const MAX_GEVOLGDE_ACCOUNTS = Number(process.env.MAX_TRACKED_ACCOUNTS ?? 40);

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
  theme: string | null;
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
  nieuweAccounts: number;
}> {
  const supabase = db();
  const provider = getMetricsProvider();

  const [accountsRes, queriesRes] = await Promise.all([
    supabase.from('tracked_accounts').select('id, handle, platform, theme').eq('our_own', false),
    supabase.from('search_queries').select('id, query, platform, theme').eq('actief', true),
  ]);
  if (accountsRes.error) throw accountsRes.error;
  if (queriesRes.error) throw queriesRes.error;

  const accounts = accountsRes.data ?? [];
  const queries = queriesRes.data ?? [];
  const themes: Theme[] = await loadThemes();

  if (accounts.length === 0 && queries.length === 0 && themes.length === 0) {
    throw new Error('Niets om te onderzoeken. Voeg thema\'s, accounts of zoektermen toe op de Research-pagina.');
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
        // Zelfde plafond als elders: een account met één mega-hit levert anders
        // scores van honderden keer de mediaan, die de retro scheeftrekken.
        const score = Math.min(post.views / accountMediaan, MAX_OUTLIER_SCORE);
        if (score < OUTLIER_DREMPEL) continue;
        const vpd = viewsPerDag(post);
        outliers.push({
          ...post,
          handle: post.handle ?? account.handle,
          platform: account.platform as Platform,
          outlier_score: round2(score),
          views_per_dag: vpd !== null ? Math.round(vpd) : null,
          theme: (account.theme as string | null) ?? null,
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
      const hits = pakUitschieters(posts, 10);

      for (const hit of hits) {
        outliers.push({
          ...hit.post,
          platform,
          outlier_score: round2(hit.score),
          views_per_dag: hit.vpd !== null ? Math.round(hit.vpd) : null,
          theme: (q.theme as string | null) ?? null,
          gevonden_via: `zoekterm:${q.query}`,
          accountId: null,
        });
      }
    } catch (e) {
      fouten.push({ bron: `zoekterm:${q.query}`, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Deel 3 — platformbreed: wat is er überhaupt trending, los van wie we
  // volgen of waar we op zoeken. Shorts is gratis; TikTok en Reels zodra de
  // scraping-key er is (tot die tijd wordt de fout per platform gelogd).
  for (const platform of ['shorts', 'tiktok', 'reels'] as Platform[]) {
    try {
      // Bewust klein gehouden: de trending-feeds zijn wereldwijd en niet op
      // regio te filteren, dus ze leveren veel content die niets met ons
      // materiaal te maken heeft. De themazoekopdrachten met Nederlandse
      // termen zijn de relevante bron; dit is aanvulling.
      const posts = await provider.fetchTrending(platform, 20);
      if (platform !== 'shorts') {
        await logProviderUsage(provider.name, 'fetch_trending', 1, provider.costPerCallEur);
      }

      const hits = pakUitschieters(posts, 10);

      for (const hit of hits) {
        outliers.push({
          ...hit.post,
          platform,
          outlier_score: round2(hit.score),
          views_per_dag: hit.vpd !== null ? Math.round(hit.vpd) : null,
          theme: null,
          gevonden_via: `trending:${platform}`,
          accountId: null,
        });
      }
    } catch (e) {
      fouten.push({ bron: `trending:${platform}`, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Deel 4 — per thema, over alle platforms. Dit is waar de tool niche-kennis
  // opbouwt: wat werkt in comedy is iets anders dan wat werkt in financien, en
  // dat verschilt per platform. Elke vondst wordt aan zijn thema gekoppeld
  // zodat de retro er aparte gewichten uit kan leren.
  for (const thema of themes) {
    for (const zoekterm of thema.zoektermen) {
      for (const platform of PLATFORMS) {
        try {
          const posts =
            platform === 'shorts'
              ? await searchYoutubeShorts(zoekterm, 15)
              : await provider.searchPosts(zoekterm, platform, 20);
          if (platform !== 'shorts') {
            await logProviderUsage(provider.name, 'search_posts', 1, provider.costPerCallEur);
          }

          for (const hit of pakUitschieters(posts)) {
            outliers.push({
              ...hit.post,
              platform,
              outlier_score: round2(hit.score),
              views_per_dag: hit.vpd !== null ? Math.round(hit.vpd) : null,
              theme: thema.slug,
              gevonden_via: `thema:${thema.slug}/${zoekterm}`,
              accountId: null,
            });
          }
        } catch (e) {
          fouten.push({
            bron: `thema:${thema.slug}/${zoekterm}/${platform}`,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }

  outliers.sort((a, b) => b.outlier_score - a.outlier_score);
  const teDecoderen = dedupeByUrl(outliers).slice(0, 25);

  // Decoderen is een verrijking, geen voorwaarde: als de Claude-call faalt
  // (bijvoorbeeld op credits), bewaren we de vondsten alsnog en decoderen we
  // een volgende run. Research-data mag niet verdwijnen omdat het LLM hapert.
  // Vondsten zonder thema (trending) krijgen er alsnog een, zodat ze in de
  // juiste niche-kennis terechtkomen in plaats van op een grote hoop.
  if (themes.length > 0) {
    const zonderThema = teDecoderen.filter((o) => !o.theme);
    if (zonderThema.length > 0) {
      try {
        const toegewezen = await classificeerThemas(themes, zonderThema);
        for (const outlier of zonderThema) {
          const gevonden = toegewezen.get(outlier.post_url);
          if (gevonden && gevonden !== 'onbekend') outlier.theme = gevonden;
        }
      } catch (e) {
        fouten.push({ bron: 'themaclassificatie', error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

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
        theme: outlier.theme,
        caption: outlier.caption,
        decoded: analyse ?? null,
      },
      { onConflict: 'post_url' },
    );
    if (upsertError) {
      fouten.push({ bron: `opslaan:${outlier.post_url}`, error: upsertError.message });
    }
  }

  const nieuweAccounts = await volgOntdekteAccounts(teDecoderen);
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
    nieuweAccounts,
  };
}

/**
 * Neemt ontdekte accounts op in de volglijst. Dit is de kern van hoe
 * outlier-research werkt: een uitschieter bestaat alleen ten opzichte van de
 * eigen mediaan van een account, en die kun je pas berekenen als je dat account
 * structureel meet. Eén losse vondst zegt weinig; hetzelfde account over
 * dertig posts zegt alles.
 *
 * We nemen alleen accounts op met een thema (anders weten we niet in welke
 * niche hun kennis telt) en stoppen bij MAX_GEVOLGDE_ACCOUNTS, omdat elk
 * account per run een credit kost.
 */
async function volgOntdekteAccounts(outliers: Outlier[]): Promise<number> {
  const supabase = db();

  const { data: bestaand } = await supabase.from('tracked_accounts').select('handle, platform, our_own');
  const bekend = new Set((bestaand ?? []).map((a) => `${a.handle.toLowerCase()}|${a.platform}`));
  const extern = (bestaand ?? []).filter((a) => !a.our_own).length;

  let ruimte = Math.max(0, MAX_GEVOLGDE_ACCOUNTS - extern);
  if (ruimte === 0) return 0;

  // Beste presteerders eerst, zodat we de ruimte aan de interessantste geven.
  const kandidaten = [...outliers]
    .filter((o) => o.handle && o.theme)
    .sort((a, b) => b.outlier_score - a.outlier_score);

  let toegevoegd = 0;
  for (const kandidaat of kandidaten) {
    if (ruimte === 0) break;
    const handle = kandidaat.handle!.replace(/^@/, '');
    const sleutel = `${handle.toLowerCase()}|${kandidaat.platform}`;
    if (bekend.has(sleutel)) continue;

    const { error } = await supabase.from('tracked_accounts').insert({
      handle,
      platform: kandidaat.platform,
      our_own: false,
      theme: kandidaat.theme,
      auto_added: true,
      ontdekt_via: kandidaat.gevonden_via,
      laatst_gezien: new Date().toISOString(),
    });
    if (error) continue;

    bekend.add(sleutel);
    ruimte--;
    toegevoegd++;
  }

  return toegevoegd;
}

const classificatieSchema = z.object({
  toewijzingen: z.array(z.object({ post_url: z.string(), theme: z.string() })),
});

/** Wijst per post het best passende thema toe; "onbekend" blijft leeg. */
async function classificeerThemas(themes: Theme[], posts: Outlier[]): Promise<Map<string, string>> {
  const { system, user } = buildClassifyPrompt(themes, posts);
  const result = await structuredCall({
    system,
    user,
    schema: classificatieSchema,
    toolName: 'lever_themas',
    toolDescription: 'Wijs per post het best passende thema toe.',
    maxTokens: 4000,
    effort: 'low',
    operation: 'scout_classificatie',
  });

  const geldig = new Set(themes.map((t) => t.slug));
  return new Map(
    result.toewijzingen
      .filter((t) => geldig.has(t.theme))
      .map((t) => [t.post_url, t.theme] as const),
  );
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
        thema: o.theme,
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

const PLATFORMS: Platform[] = ['shorts', 'tiktok', 'reels'];

/**
 * Binnen een resultatenset is views-per-dag de eerlijke maat; ontbreekt de
 * posttijd (zoals bij de snelle Shorts-listing, die al op deze week filtert),
 * dan zijn ruwe views binnen die set alsnog vergelijkbaar.
 */
function pakUitschieters(posts: AccountPost[], maxHits = 8) {
  // Instagram geeft lang niet altijd een viewcount terug; likes zijn daar de
  // beste beschikbare maat voor hoe goed iets liep.
  const opLikes = posts.every((p) => p.views === null);
  const waarde = (p: AccountPost) => (opLikes ? p.likes : p.views);

  const bruikbaar = posts.filter((p) => waarde(p) !== null && Boolean(p.post_url));

  // Eén maat voor de hele set. Views-per-dag en ruwe views door elkaar halen
  // levert een onzinnige mediaan op (een post van vandaag met 5.000 views/dag
  // naast een post met 200.000 totale views), en daarmee onzinnige scores.
  const alleMetDatum = !opLikes && bruikbaar.every((p) => viewsPerDag(p) !== null);
  const scored = bruikbaar.map((p) => {
    const vpd = opLikes ? null : viewsPerDag(p);
    return { post: p, vpd, metriek: (alleMetDatum ? vpd : waarde(p)) as number };
  });

  const setMediaan = median(scored.map((x) => x.metriek));

  // Een set met te weinig posts, of waarin de mediaan bijna nul is (premières
  // en verse uploads zonder views), geeft absurde scores: één trailer met 18k
  // views naast een mediaan van 1 wordt dan een "18000x uitschieter". Zulke
  // sets zeggen niets, dus die slaan we over.
  if (!setMediaan || scored.length < MIN_SET_OMVANG || setMediaan < MIN_MEDIAAN) return [];

  return scored
    .map((x) => ({ ...x, score: Math.min(x.metriek / setMediaan, MAX_OUTLIER_SCORE) }))
    .filter((x) => x.score >= DISCOVERY_DREMPEL)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxHits);
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
/** Een regel krijgt een thema als alle onderbouwende posts uit datzelfde thema komen. */
function themeVanPosts(postUrls: string[], outliers: { post_url: string; theme?: string | null }[]): string | null {
  const themas = new Set(
    postUrls.map((url) => outliers.find((o) => o.post_url === url)?.theme).filter((t): t is string => Boolean(t)),
  );
  return themas.size === 1 ? [...themas][0] : null;
}

async function schrijfKandidaten(
  decoded: ScoutDecoded,
  outliers: { post_url: string; handle: string | null; theme?: string | null }[],
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
      theme: themeVanPosts(kandidaat.post_urls, outliers),
    });
    if (!error) geschreven++;
  }

  return geschreven;
}
