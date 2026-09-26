import { z } from 'zod';
import { structuredCall } from '../claude';
import { AGENT_EFFORT, CLAUDE_LICHT_MODEL } from '../env';
import { db, logProviderUsage } from '../supabase';
import { Theme, VaultSnapshot, buildClassifyPrompt, loadThemes, loadVault, renderVaultForPrompt } from '../vault';
import { median } from '../tracking/performance';
import { AccountPost, MetricsProvider, Platform, getFallbackProvider, getMetricsProvider } from '../tracking/provider';
import { searchYoutubeShorts } from '../tracking/youtube-discovery';

/** Hoe ver een post boven de mediaan van zijn eigen account moet zitten. */
export const OUTLIER_DREMPEL = 3;
/**
 * Voor zoekresultaten: hoe ver boven de mediaan views-per-dag van de zoekset.
 * Op 2x markeerde dit ~30% van élke zoekset als uitschieter; 3x houdt alleen
 * over wat echt boven de set uitsteekt.
 */
export const DISCOVERY_DREMPEL = 3;
/** Onder deze grenzen is een resultatenset te dun om iets uit af te leiden. */
export const MIN_SET_OMVANG = 5;
export const MIN_MEDIAAN = 500;
/**
 * Bovengrens tegen deel-door-bijna-nul. Ruim gezet: 8 miljoen views bij een
 * mediaan van 80.000 is een echte 100x en moet te onderscheiden blijven van 5x.
 */
export const MAX_OUTLIER_SCORE = 500;
/** Zoveel posts hebben we minstens nodig voor een geloofwaardige accountmediaan. */
export const MIN_POSTS_VOOR_MEDIAAN = 8;
/**
 * Binnen hoeveel dagen een post moet vallen om mee te tellen. Een virale hit
 * van twee jaar geleden afzetten tegen de mediaan van vandaag geeft scores van
 * 500x die niets zeggen: het account was toen simpelweg groter of had geluk.
 * Een uitschieter is pas interessant als hij nú boven het eigen niveau uitkomt.
 */
export const OUTLIER_VENSTER_DAGEN = Number(process.env.OUTLIER_VENSTER_DAGEN ?? 120);
/**
 * Een account moet normaal gesproken dit aantal views halen voordat we het
 * serieus nemen. Een account met een mediaan van 400 views dat één keer 600.000
 * haalt is geen 1400x-uitschieter maar een toevalstreffer: er valt niets van te
 * leren en het verpest de statistiek. Dit is waarom outlier-tools drempels op
 * views hanteren.
 */
export const MIN_ACCOUNT_MEDIAAN = Number(process.env.MIN_ACCOUNT_MEDIAAN ?? 5000);
/**
 * En de bovengrens: een account met een mediaan van vijf miljoen (MrBeast,
 * Lamine Yamal) is een mediafenomeen, geen vakgenoot. Alles wat zo'n account
 * doet "werkt", en er is niets van over te nemen met ons bronmateriaal. Zulke
 * accounts volgen we niet, en als ze al in de lijst staan gaan ze eruit.
 */
export const MAX_VOLG_MEDIAAN = Number(process.env.MAX_VOLG_MEDIAAN ?? 5_000_000);

/**
 * Basislijn voor de edit-vingerafdruk: per gevolgd account ook een paar
 * gewone posts (rond de eigen mediaan, zelfde periode) bewaren. Zonder die
 * vergelijking weet je alleen wat uitschieters doen, niet wat ze ánders doen
 * dan hetzelfde account op een gewone dag — en dat verschil is de les
 * (src/lib/vault/normen.ts). Geen Claude-decodering: ze worden alleen gemeten.
 */
export const BASISLIJN_PER_ACCOUNT = 2;
export const MAX_BASISLIJN_PER_RUN = 40;

/** Een kandidaat-heuristiek moet over minstens zoveel verschillende accounts terugkomen. */
export const MIN_ACCOUNTS_PER_HEURISTIEK = 2;
/**
 * Hoeveel accounts we tegelijk een basislijn geven. Dit is geen lijst met
 * concurrenten die je bijhoudt, maar een technisch hulpmiddel: een uitschieter
 * bestaat alleen ten opzichte van het normale niveau van een account, en dat
 * moet je dus meten. De tool vult deze lijst zelf op basis van wat hij
 * tegenkomt, en ruimt hem ook zelf op.
 *
 * Elk account kost een paar credits per run; dit is dus ook de budgetknop.
 */
export const MAX_GEVOLGDE_ACCOUNTS = Number(process.env.MAX_TRACKED_ACCOUNTS ?? 60);
/**
 * Accounts die zo lang geen uitschieter meer opleverden ruimen we op, zodat de
 * lijst zichzelf ververst in plaats van vol te lopen met eenmalige toevalstreffers.
 */
export const OPRUIM_NA_DAGEN = 30;
/**
 * Een 404/gedeactiveerd account is een hard signaal, geen ruis — na dit
 * aantal opeenvolgende mislukkingen (dus dagen, bij 2 runs/dag) is verder
 * proberen zonde van de credits.
 */
export const MAX_OPEENVOLGENDE_FOUTEN = 3;
/**
 * Hoeveel ontdekte accounts we per run een proefmeting geven vóór we ze
 * volgen. Elke proefmeting kost een credit; zonder plafond kan één rijke
 * zoekset tientallen credits opslokken.
 */
export const MAX_PROEFMETINGEN_PER_RUN = 8;
/**
 * Verdeling van de decodeerbatch over de bronnen. Zonder quota verdrong een
 * trending-set met één 200x-post structureel de account-uitschieters (3-10x),
 * terwijl juist díe de enige zijn met een echte basislijn en dus retro-data.
 */
export const DECODEER_QUOTA: Record<Bron, number> = { account: 15, thema: 10, zoekterm: 5, trending: 5 };
export const DECODEER_BATCH = Object.values(DECODEER_QUOTA).reduce((a, b) => a + b, 0);
/**
 * Transcripten ophalen kost tijd (yt-dlp, twee calls per video); dit is het
 * plafond per run zodat de scout niet een uur op ondertitels staat te wachten.
 */
export const MAX_TRANSCRIPTEN_PER_RUN = Number(process.env.SCOUT_MAX_TRANSCRIPTEN ?? 12);
const TRANSCRIPT_TIMEOUT_MS = 60_000;
const MAX_TRANSCRIPT_TEKENS = 1500;

type Bron = 'account' | 'thema' | 'zoekterm' | 'trending';

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

/**
 * Wat er per post in scout_finds.decoded landt: de modelanalyse plus onze
 * eigen inschatting van hoeveel die waard is. Op caption alleen is een
 * hook-type gokwerk; met transcript is het een waarneming. Retro en trends
 * kunnen daar naar wegen.
 */
export type DecodedPost = ScoutDecoded['posts'][number] & { betrouwbaarheid: 'laag' | 'hoog' };

const SCOUT_SYSTEM = `Je bent de Scout-agent van een clipping-tool. Je krijgt posts van ANDERE accounts die bovengemiddeld presteren — deels van accounts die we volgen, deels gevonden via zoektermen op de platforms zelf. Daarnaast krijg je onze eigen vault.

Je taak is decoderen, niet bewonderen: waarom werkt deze post? Kijk naar de hook, de structuur van het verhaal en het instappunt.

Over de invoer:
- Sommige posts hebben een "transcript": de uitgesproken tekst, met daarin de echte eerste seconden. Baseer hook en structuur dan dáárop; de caption is bijzaak.
- Posts zonder transcript hebben alleen een caption. Decodeer ze, maar wees terughoudend: kies de dichtstbijzijnde slug en zet in waarom_het_werkt wat je wél en niet kunt zien.

Regels:
- "hook_type" en "structuur" zijn HARDE EISEN, geen vrije beschrijving: gebruik EXACT een slug uit "ONZE VAULT" hieronder als het patroon van deze post ook maar redelijk bij een bestaande slug past. Past er écht geen enkele, gebruik dan "nieuw:" gevolgd door een korte naam — maar dat is de uitzondering, niet de standaard. De Retro-agent telt alleen mee wat op een bestaande slug matcht; een vrij geformuleerde beschrijving ("straatinterview waarbij...") is voor die telling onzichtbaar, ook al beschrijft hij feitelijk hetzelfde patroon als een bestaande slug. Twijfel je tussen twee slugs, kies de dichtstbijzijnde in plaats van zelf iets nieuws te verzinnen.
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
  bron: Bron;
  transcript?: string | null;
};

export type ScoutResultaat = {
  agentRunId: string;
  accountsBekeken: number;
  zoektermen: number;
  outliers: number;
  kandidaten: number;
  nieuweAccounts: number;
  gedecodeerd: number;
  fouten: { bron: string; error: string }[];
  /** Foutmelding van de provider als Reels deze run niet beschikbaar was (402). */
  reelsGeblokkeerd: string | null;
  status: 'auto' | 'partial';
};

/**
 * Dagelijkse research-run in twee delen:
 * 1. Accounts die we volgen: uitschieters t.o.v. de mediaan van dat account.
 * 2. Zoektermen op de platforms zelf (het Sandcastles-idee): wat gaat er binnen
 *    onze niche viraal, ongeacht van wie het is. Shorts lopen gratis via yt-dlp;
 *    TikTok en Reels via de scraping-provider.
 *
 * Alles wordt gedecodeerd en bewaard; kandidaat-heuristieken worden pas actief
 * nadat de Retro-agent ze met echte cijfers bevestigt (sectie 10).
 */
export async function runScoutAgent(options?: { limitPerAccount?: number }): Promise<ScoutResultaat> {
  const supabase = db();
  const provider = getMetricsProvider();

  const [accountsRes, queriesRes] = await Promise.all([
    supabase
      .from('tracked_accounts')
      .select('id, handle, platform, theme, opeenvolgende_fouten, auto_added, median_views_7d')
      .eq('our_own', false),
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
  const basislijn: Outlier[] = [];
  const fouten: { bron: string; error: string }[] = [];

  // Reels loopt uitsluitend via de betaalde provider. Zodra die 402 geeft
  // (credits op) is elke volgende Reels-call dezelfde fout; die slaan we dan
  // over met één logregel in plaats van tientallen identieke foutregels.
  let reelsGeblokkeerd: string | null = null;
  const reelsOverslaan = (): boolean => reelsGeblokkeerd !== null;
  const registreerFout = (bron: string, e: unknown) => {
    const bericht = e instanceof Error ? e.message : String(e);
    if (/ScrapeCreators 402/.test(bericht) && !reelsGeblokkeerd) {
      reelsGeblokkeerd = bericht.slice(0, 160);
      console.warn(`[scout] Reels overgeslagen voor de rest van deze run: ${reelsGeblokkeerd}`);
    }
    fouten.push({ bron, error: bericht });
  };

  // Valt de betaalde provider om (geen credits, rate limit, storing), dan is
  // gratis via yt-dlp alsnog beter dan een lege run. Dekt in de praktijk
  // alleen TikTok-accounts volgen (de enige call die de gratis provider ook
  // echt ondersteunt); voor zoeken/trending op TikTok en alles op Reels
  // bestaat geen gratis route, dus daar gooit de fallback zijn eigen
  // duidelijke fout en komt de oorspronkelijke fout gewoon terecht in `fouten`.
  const fallbackProvider = getFallbackProvider(provider);
  // Zodra de betaalde provider één keer 402 (credits op) gaf, is elke
  // volgende call dezelfde fout: dan meteen naar de gratis route, zonder de
  // wachttijd en zonder tientallen identieke foutregels.
  let providerZonderCredits = false;
  async function metFallback<T>(
    fn: (p: MetricsProvider) => Promise<T>,
  ): Promise<{ data: T; provider: MetricsProvider }> {
    let eersteFout: unknown = null;
    if (!providerZonderCredits || !fallbackProvider) {
      try {
        return { data: await fn(provider), provider };
      } catch (e) {
        eersteFout = e;
        if (/ScrapeCreators 402/.test(e instanceof Error ? e.message : String(e))) providerZonderCredits = true;
        if (!fallbackProvider) throw e;
      }
    }
    try {
      return { data: await fn(fallbackProvider!), provider: fallbackProvider! };
    } catch (e2) {
      // Met credits op is de gratis fout de informatieve ("geen gratis route
      // voor zoeken op TikTok"); anders is de oorspronkelijke providerfout dat.
      throw providerZonderCredits ? e2 : (eersteFout ?? e2);
    }
  }

  // Deel 1 — accounts die we volgen.
  let accountsBekeken = 0;
  for (const account of accounts) {
    const platform = account.platform as Platform;
    if (platform === 'reels' && reelsOverslaan()) continue;

    // Mediafenomenen zijn ruis (zie MAX_VOLG_MEDIAAN). Automatisch toegevoegde
    // gaan eruit; een handmatig toegevoegd account laten we staan maar meten
    // we niet, en dat zeggen we.
    const bekendeMediaan = (account.median_views_7d as number | null) ?? 0;
    if (bekendeMediaan > MAX_VOLG_MEDIAAN) {
      if (account.auto_added) {
        await supabase.from('tracked_accounts').delete().eq('id', account.id);
        fouten.push({ bron: `account:@${account.handle}`, error: `verwijderd: mediaan ${bekendeMediaan} > ${MAX_VOLG_MEDIAAN} (mediafenomeen, geen vakgenoot)` });
      } else {
        fouten.push({ bron: `account:@${account.handle}`, error: `overgeslagen: mediaan ${bekendeMediaan} > ${MAX_VOLG_MEDIAAN}; verwijder het account handmatig als je het niet wilt volgen` });
      }
      continue;
    }

    try {
      const { data: posts, provider: gebruikt } = await metFallback((p) =>
        p.fetchAccountPosts(account.handle, platform, options?.limitPerAccount ?? 30),
      );
      await logProviderUsage(gebruikt.name, 'fetch_account_posts', 1, gebruikt.costPerCallEur);
      accountsBekeken++;

      // Een geslaagde fetch bewijst dat het account leeft, ongeacht of hij
      // deze keer de mediaan-drempel haalt — dat telt niet als "fout" en mag
      // de teller resetten.
      if (((account.opeenvolgende_fouten as number | null) ?? 0) > 0) {
        await supabase.from('tracked_accounts').update({ opeenvolgende_fouten: 0 }).eq('id', account.id);
      }

      const meting = meetAccount(posts);
      if (!meting) continue;

      for (const post of kiesBasislijn(meting.recent, meting.mediaan)) {
        const vpd = viewsPerDag(post);
        basislijn.push({
          ...post,
          handle: handleUitUrl(post.post_url, post.handle ?? account.handle),
          platform,
          outlier_score: round2(post.views! / meting.mediaan),
          views_per_dag: vpd !== null ? Math.round(vpd) : null,
          theme: (account.theme as string | null) ?? null,
          gevonden_via: `basislijn:@${account.handle}`,
          accountId: account.id,
          bron: 'account',
        });
      }

      for (const post of meting.recent) {
        if (post.views === null || !post.post_url) continue;
        // Zelfde plafond als elders: een account met één mega-hit levert anders
        // scores van honderden keer de mediaan, die de retro scheeftrekken.
        const score = Math.min(post.views / meting.mediaan, MAX_OUTLIER_SCORE);
        if (score < OUTLIER_DREMPEL) continue;
        const vpd = viewsPerDag(post);
        outliers.push({
          ...post,
          handle: handleUitUrl(post.post_url, post.handle ?? account.handle),
          platform,
          outlier_score: round2(score),
          views_per_dag: vpd !== null ? Math.round(vpd) : null,
          theme: (account.theme as string | null) ?? null,
          gevonden_via: `account:@${account.handle}`,
          accountId: account.id,
          bron: 'account',
        });
      }

      await supabase
        .from('tracked_accounts')
        .update({
          median_views_7d: Math.round(meting.mediaan),
          laatst_gezien: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', account.id);
    } catch (e) {
      registreerFout(`account:@${account.handle}`, e);

      // Een account dat 3 runs op rij hard faalt (404, gedeactiveerd) is dood,
      // niet tijdelijk stil — dat hoeft niet op de trage 30-dagen-opruiming
      // (ruimOpgedroogdeAccountsOp) te wachten, die alleen stille-maar-levende
      // accounts opruimt. Zonder dit werd elke run opnieuw credits verspild aan
      // exact dezelfde vaste 404's. Alleen automatisch ontdekte accounts: een
      // handmatig toegevoegd account verwijderen we niet zonder het te zeggen.
      // Een 402 (credits op) zegt niets over het account en telt niet mee.
      if (platform === 'reels' && reelsGeblokkeerd) continue;
      const fouten_nu = ((account.opeenvolgende_fouten as number | null) ?? 0) + 1;
      if (fouten_nu >= MAX_OPEENVOLGENDE_FOUTEN && account.auto_added) {
        await supabase.from('tracked_accounts').delete().eq('id', account.id);
        fouten.push({
          bron: `account:@${account.handle}`,
          error: `verwijderd na ${fouten_nu} mislukte runs op rij`,
        });
      } else {
        await supabase.from('tracked_accounts').update({ opeenvolgende_fouten: fouten_nu }).eq('id', account.id);
      }
    }
  }

  // Deel 2 — zoektermen op de platforms zelf.
  for (const q of queries) {
    const platform = q.platform as Platform;
    if (platform === 'reels' && reelsOverslaan()) continue;
    try {
      let posts: AccountPost[];
      if (platform === 'shorts') {
        posts = await searchYoutubeShorts(q.query, 12);
      } else {
        const { data, provider: gebruikt } = await metFallback((p) => p.searchPosts(q.query, platform, 50));
        posts = data;
        await logProviderUsage(gebruikt.name, 'search_posts', 1, gebruikt.costPerCallEur);
      }

      // Binnen een zoekset is views-per-dag de eerlijke maat: een post van
      // gisteren met 40k views verslaat een post van twee jaar oud met 200k.
      // Geeft de bron geen posttijd (de snelle Shorts-listing filtert dan al op
      // "deze week"), dan zijn ruwe views binnen de set alsnog vergelijkbaar.
      for (const hit of pakUitschieters(posts, 10)) {
        outliers.push({
          ...hit.post,
          platform,
          outlier_score: round2(hit.score),
          views_per_dag: hit.vpd !== null ? Math.round(hit.vpd) : null,
          theme: (q.theme as string | null) ?? null,
          gevonden_via: `zoekterm:${q.query}`,
          accountId: null,
          bron: 'zoekterm',
        });
      }
    } catch (e) {
      registreerFout(`zoekterm:${q.query}`, e);
    }
  }

  // Deel 3 — platformbreed: wat is er überhaupt trending, los van wie we
  // volgen of waar we op zoeken. Shorts is gratis; TikTok en Reels zodra de
  // scraping-key er is (tot die tijd wordt de fout per platform gelogd).
  for (const platform of ['shorts', 'tiktok', 'reels'] as Platform[]) {
    if (platform === 'reels' && reelsOverslaan()) continue;
    try {
      // Bewust klein gehouden: de trending-feeds zijn wereldwijd en niet op
      // regio te filteren, dus ze leveren veel content die niets met ons
      // materiaal te maken heeft. De themazoekopdrachten met Nederlandse
      // termen zijn de relevante bron; dit is aanvulling.
      const { data: posts, provider: gebruikt } = await metFallback((p) => p.fetchTrending(platform, 40));
      if (platform !== 'shorts') {
        await logProviderUsage(gebruikt.name, 'fetch_trending', 1, gebruikt.costPerCallEur);
      }

      for (const hit of pakUitschieters(posts, 10)) {
        outliers.push({
          ...hit.post,
          platform,
          outlier_score: round2(hit.score),
          views_per_dag: hit.vpd !== null ? Math.round(hit.vpd) : null,
          theme: null,
          gevonden_via: `trending:${platform}`,
          accountId: null,
          bron: 'trending',
        });
      }
    } catch (e) {
      registreerFout(`trending:${platform}`, e);
    }
  }

  // Deel 4 — per thema, over alle platforms. Dit is waar de tool niche-kennis
  // opbouwt: wat werkt in comedy is iets anders dan wat werkt in financien, en
  // dat verschilt per platform. Elke vondst wordt aan zijn thema gekoppeld
  // zodat de retro er aparte gewichten uit kan leren.
  for (const thema of themes) {
    for (const zoekterm of thema.zoektermen) {
      for (const platform of PLATFORMS) {
        if (platform === 'reels' && reelsOverslaan()) continue;
        try {
          let posts: AccountPost[];
          if (platform === 'shorts') {
            posts = await searchYoutubeShorts(zoekterm, 15);
          } else {
            const { data, provider: gebruikt } = await metFallback((p) => p.searchPosts(zoekterm, platform, 20));
            posts = data;
            await logProviderUsage(gebruikt.name, 'search_posts', 1, gebruikt.costPerCallEur);
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
              bron: 'thema',
            });
          }
        } catch (e) {
          registreerFout(`thema:${thema.slug}/${zoekterm}/${platform}`, e);
        }
      }
    }
  }

  if (reelsGeblokkeerd) {
    const overgeslagen = fouten.filter((f) => /ScrapeCreators 402/.test(f.error)).length;
    console.warn(`[scout] Reels: ${overgeslagen} bron(nen) gaven 402; overige Reels-bronnen overgeslagen.`);
  }

  const teDecoderen = kiesDecodeerBatch(dedupeByUrl(outliers));

  // Achterstallige decodering. De belofte hieronder ("decoderen we een
  // volgende run alsnog") bestond lang alleen als comment: vondsten waarvan de
  // Claude-call ooit faalde bleven voor altijd ongedecodeerd liggen, en alles
  // wat op decoded bouwt (retro, trends, kijken) zag ze nooit. Daarom hier
  // echt: een handvol oude ongedecodeerde vondsten meenemen in dezelfde batch.
  try {
    const alInBatch = new Set(teDecoderen.map((o) => o.post_url));
    const { data: achterstallig } = await supabase
      .from('scout_finds')
      .select('tracked_account_id, handle, platform, post_url, posted_at, views, likes, comments, outlier_score, views_per_dag, gevonden_via, theme, caption, transcript')
      .is('decoded', null)
      // Basislijn-rijen worden bewust niet gedecodeerd (alleen gemeten).
      .eq('is_basislijn', false)
      .order('created_at', { ascending: false })
      .limit(15);
    for (const rij of achterstallig ?? []) {
      if (alInBatch.has(rij.post_url as string)) continue;
      const via = (rij.gevonden_via as string | null) ?? 'achterstallig';
      teDecoderen.push({
        post_url: rij.post_url as string,
        posted_at: rij.posted_at as string | null,
        views: rij.views as number | null,
        likes: rij.likes as number | null,
        comments: rij.comments as number | null,
        caption: rij.caption as string | null,
        handle: rij.handle as string,
        raw: null,
        platform: rij.platform as Platform,
        theme: rij.theme as string | null,
        outlier_score: (rij.outlier_score as number | null) ?? 0,
        views_per_dag: rij.views_per_dag as number | null,
        gevonden_via: via,
        accountId: rij.tracked_account_id as string | null,
        bron: bronVan(via),
        transcript: transcriptTekst(rij.transcript),
      });
    }
  } catch {
    // Backlog is een extraatje; de verse vondsten gaan altijd voor.
  }

  // Transcripten: op caption alleen is een hook-type gokwerk. Waar het gratis
  // kan (Shorts, via de ondertitels) halen we de uitgesproken tekst erbij;
  // dat is wat een vondst van "leuke caption" naar een echte waarneming tilt.
  await vulTranscriptenAan(teDecoderen, fouten);

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
  let decoderingGefaald = false;
  if (teDecoderen.length > 0) {
    try {
      const vault = await loadVault();
      decoded = normaliseerSlugs(await decodeer(teDecoderen, vault), vault);
    } catch (e) {
      decoderingGefaald = true;
      fouten.push({ bron: 'decodering', error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Vondsten bewaren, zodat elke heuristiek terug te voeren is op echte posts.
  // Bestaande decodering en de markers van de kijk-passen (visueel,
  // effecten_gezien) blijven staan: we zetten decoded alleen als er een
  // nieuwe analyse is, en dan gemengd met wat er al lag.
  const bestaandeDecoded = await laadBestaandeDecoded(teDecoderen.map((o) => o.post_url));
  const transcriptAanwezig = new Set(teDecoderen.filter((o) => o.transcript).map((o) => o.post_url));
  for (const outlier of teDecoderen) {
    const analyse = decoded.posts.find((p) => p.post_url === outlier.post_url);
    const rij: Record<string, unknown> = {
      tracked_account_id: outlier.accountId,
      handle: outlier.handle ?? 'onbekend',
      platform: outlier.platform,
      post_url: outlier.post_url,
      posted_at: outlier.posted_at,
      views: outlier.views,
      likes: outlier.likes,
      comments: outlier.comments,
      // Alleen een echte outlier-score als we hem tegen de eigen mediaan van
      // het account konden afzetten. Bij zoek- en trending-vondsten kennen we
      // die basislijn nog niet; dat zijn vondsten om accounts te ontdekken,
      // geen prestatiemeting. Zodra zo'n account gevolgd wordt, krijgt het
      // wel een echte score.
      outlier_score: outlier.gevonden_via.startsWith('account:') ? outlier.outlier_score : null,
      views_per_dag: outlier.views_per_dag,
      gevonden_via: outlier.gevonden_via,
      theme: outlier.theme,
      caption: outlier.caption,
      // Een post die eerder als gewone basislijnpost bewaard is en nu
      // uitschiet, is vanaf nu een vondst.
      is_basislijn: false,
    };
    if (outlier.transcript) rij.transcript = { tekst: outlier.transcript };
    if (analyse) {
      const oud = bestaandeDecoded.get(outlier.post_url) ?? {};
      const nieuw: DecodedPost = { ...analyse, betrouwbaarheid: transcriptAanwezig.has(outlier.post_url) ? 'hoog' : 'laag' };
      rij.decoded = { ...oud, ...nieuw };
    }
    const { error: upsertError } = await supabase.from('scout_finds').upsert(rij, { onConflict: 'post_url' });
    if (upsertError) {
      fouten.push({ bron: `opslaan:${outlier.post_url}`, error: upsertError.message });
    }
  }

  const basislijnBewaard = await bewaarBasislijn(basislijn, new Set(teDecoderen.map((o) => o.post_url)), fouten);

  const nieuweAccounts = await volgOntdekteAccounts(teDecoderen, provider, fouten, reelsGeblokkeerd !== null);
  const kandidaten = await schrijfKandidaten(decoded, teDecoderen);

  const status: 'auto' | 'partial' = decoderingGefaald ? 'partial' : 'auto';
  const runRij = {
    agent: 'scout',
    input_summary: {
      accounts: accounts.length,
      accounts_bekeken: accountsBekeken,
      zoektermen: queries.length,
      posts_bekeken: outliers.length,
      basislijn_bewaard: basislijnBewaard,
      gedecodeerd: decoded.posts.length,
      met_transcript: transcriptAanwezig.size,
      reels_geblokkeerd: reelsGeblokkeerd,
      fouten,
    },
    proposal: decoded,
  };
  let { data: run, error: runError } = await supabase
    .from('agent_runs')
    .insert({ ...runRij, status })
    .select()
    .single();
  // Zolang de schema-uitbreiding ('partial') nog niet op de database staat,
  // valt de run niet om: dan liever 'auto' met de fouten in input_summary.
  if (runError && status === 'partial') {
    ({ data: run, error: runError } = await supabase
      .from('agent_runs')
      .insert({ ...runRij, status: 'auto' })
      .select()
      .single());
  }
  if (runError) throw runError;

  return {
    agentRunId: run.id,
    accountsBekeken,
    zoektermen: queries.length,
    outliers: outliers.length,
    kandidaten,
    nieuweAccounts,
    gedecodeerd: decoded.posts.length,
    fouten,
    reelsGeblokkeerd,
    status,
  };
}

/**
 * Gewone posts van een account: dicht bij de eigen mediaan (factor 0,5–2,
 * dus ver onder de uitschieterdrempel), met URL en views. Dichtst bij de
 * mediaan eerst — dat is "hoe dit account normaal presteert". Puur.
 */
export function kiesBasislijn(recent: AccountPost[], mediaan: number, aantal = BASISLIJN_PER_ACCOUNT): AccountPost[] {
  if (!mediaan || mediaan <= 0) return [];
  return recent
    .filter((p) => p.post_url && p.views !== null && p.views > 0)
    .filter((p) => p.views! / mediaan >= 0.5 && p.views! / mediaan < 2)
    .sort((a, b) => Math.abs(Math.log(a.views! / mediaan)) - Math.abs(Math.log(b.views! / mediaan)))
    .slice(0, aantal);
}

/**
 * Bewaart basislijnposts zonder bestaande rijen aan te raken: een post die al
 * als vondst in de tabel staat blijft een vondst (ignoreDuplicates), en wat
 * deze run als uitschieter binnenkwam gaat sowieso voor.
 */
async function bewaarBasislijn(
  basislijn: Outlier[],
  alsVondst: Set<string>,
  fouten: { bron: string; error: string }[],
): Promise<number> {
  const rijen = dedupeByUrl(basislijn)
    .filter((b) => !alsVondst.has(b.post_url))
    .slice(0, MAX_BASISLIJN_PER_RUN)
    .map((b) => ({
      tracked_account_id: b.accountId,
      handle: b.handle ?? 'onbekend',
      platform: b.platform,
      post_url: b.post_url,
      posted_at: b.posted_at,
      views: b.views,
      likes: b.likes,
      comments: b.comments,
      // De verhouding tot de accountmediaan (~1) bewaren we wél: dat maakt
      // zichtbaar dat dit echt een gewone post is.
      outlier_score: b.outlier_score,
      views_per_dag: b.views_per_dag,
      gevonden_via: b.gevonden_via,
      theme: b.theme,
      caption: b.caption,
      is_basislijn: true,
    }));
  if (rijen.length === 0) return 0;
  const { error } = await db().from('scout_finds').upsert(rijen, { onConflict: 'post_url', ignoreDuplicates: true });
  if (error) {
    fouten.push({ bron: 'opslaan:basislijn', error: error.message });
    return 0;
  }
  return rijen.length;
}

/**
 * De basislijn van een account: mediaan over de recente posts, alleen als er
 * genoeg zijn en het account in het bereik zit waar we iets van kunnen leren.
 * Wordt gebruikt voor gevolgde accounts én als proefmeting vóór we een
 * ontdekt account gaan volgen.
 */
function meetAccount(posts: AccountPost[]): { mediaan: number; recent: AccountPost[] } | null {
  // Alleen recente posts: zo vergelijken we appels met appels.
  const recent = posts.filter((p) => binnenVenster(p.posted_at));
  const views = recent.map((p) => p.views).filter((v): v is number => v !== null);
  const mediaan = median(views);
  // Met een handvol posts zegt een mediaan niets: één virale hit tussen vijf
  // gewone posts levert scores op die over de steekproef gaan, niet over het
  // account zelf.
  if (!mediaan || views.length < MIN_POSTS_VOOR_MEDIAAN) return null;
  if (mediaan < MIN_ACCOUNT_MEDIAAN || mediaan > MAX_VOLG_MEDIAAN) return null;
  return { mediaan, recent };
}

/**
 * Neemt ontdekte accounts op in de volglijst. Dit is de kern van hoe
 * outlier-research werkt: een uitschieter bestaat alleen ten opzichte van de
 * eigen mediaan van een account, en die kun je pas berekenen als je dat account
 * structureel meet. Eén losse vondst zegt weinig; hetzelfde account over
 * dertig posts zegt alles.
 *
 * Volgen doen we pas na een proefmeting: één keer de posts ophalen en de echte
 * mediaan bepalen. Eerder volstond één post met 5.000 views, en dat vulde de
 * lijst met accounts die normaal 400 views halen (geen basislijn) of vijf
 * miljoen (mediafenomeen), plus weergavenamen die als handle niet eens
 * bestaan. Elke proefmeting kost een credit; daarom een plafond per run.
 */
async function volgOntdekteAccounts(
  outliers: Outlier[],
  provider: MetricsProvider,
  fouten: { bron: string; error: string }[],
  reelsGeblokkeerd: boolean,
): Promise<number> {
  const supabase = db();

  const { data: bestaand } = await supabase.from('tracked_accounts').select('handle, platform, our_own');
  const bekend = new Set((bestaand ?? []).map((a) => `${a.handle.toLowerCase()}|${a.platform}`));
  const extern = (bestaand ?? []).filter((a) => !a.our_own).length;

  let ruimte = Math.max(0, MAX_GEVOLGDE_ACCOUNTS - extern);
  if (ruimte === 0) return 0;

  // Beste presteerders eerst, zodat we de ruimte aan de interessantste geven.
  // Alleen accounts met een thema: anders weten we niet in welke niche hun
  // kennis telt.
  const kandidaten = [...outliers]
    .filter((o) => o.handle && o.theme && o.gevonden_via !== 'achterstallig')
    .sort((a, b) => b.outlier_score - a.outlier_score);

  let toegevoegd = 0;
  let proefmetingen = 0;
  const geprobeerd = new Set<string>();
  for (const kandidaat of kandidaten) {
    if (ruimte === 0 || proefmetingen >= MAX_PROEFMETINGEN_PER_RUN) break;
    if (kandidaat.platform === 'reels' && reelsGeblokkeerd) continue;
    const handle = (handleUitUrl(kandidaat.post_url, kandidaat.handle) ?? kandidaat.handle!).replace(/^@/, '');
    const sleutel = `${handle.toLowerCase()}|${kandidaat.platform}`;
    if (bekend.has(sleutel) || geprobeerd.has(sleutel)) continue;
    geprobeerd.add(sleutel);

    let meting: ReturnType<typeof meetAccount> = null;
    try {
      proefmetingen++;
      const posts = await provider.fetchAccountPosts(handle, kandidaat.platform, 30);
      await logProviderUsage(provider.name, 'fetch_account_posts', 1, provider.costPerCallEur);
      meting = meetAccount(posts);
    } catch (e) {
      fouten.push({ bron: `proefmeting:@${handle}`, error: e instanceof Error ? e.message.slice(0, 160) : String(e) });
      continue;
    }
    if (!meting) continue;

    const { error } = await supabase.from('tracked_accounts').insert({
      handle,
      platform: kandidaat.platform,
      our_own: false,
      theme: kandidaat.theme,
      auto_added: true,
      ontdekt_via: kandidaat.gevonden_via,
      median_views_7d: Math.round(meting.mediaan),
      laatst_gezien: new Date().toISOString(),
    });
    if (error) continue;

    bekend.add(sleutel);
    ruimte--;
    toegevoegd++;
  }

  await ruimOpgedroogdeAccountsOp();
  return toegevoegd;
}

/**
 * Verwijdert automatisch toegevoegde accounts die al een tijd niets opleveren.
 * Zonder dit loopt de lijst vol met accounts die één keer geluk hadden, en
 * verspillen we elke run credits aan het meten daarvan.
 */
async function ruimOpgedroogdeAccountsOp(): Promise<void> {
  const supabase = db();
  const grens = new Date(Date.now() - OPRUIM_NA_DAGEN * 24 * 3600 * 1000).toISOString();

  await supabase
    .from('tracked_accounts')
    .delete()
    .eq('auto_added', true)
    .eq('our_own', false)
    .lt('laatst_gezien', grens);
}

/**
 * De handle uit de post-URL, waar die erin staat (TikTok: /@handle/video/…,
 * Shorts-kanalen: /@handle/). Providers geven wisselend de weergavenaam
 * ("ESPN NL") of de handle (espnnl) terug; alleen de handle is een adres.
 * Zonder handle in de URL blijft de opgegeven naam staan.
 */
export function handleUitUrl(postUrl: string | null | undefined, fallback: string | null | undefined): string | null {
  const m = postUrl?.match(/(?:tiktok\.com|youtube\.com)\/@([^/?#]+)/);
  if (m) return decodeURIComponent(m[1]);
  return fallback ?? null;
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
    model: CLAUDE_LICHT_MODEL,
  });

  const geldig = new Set(themes.map((t) => t.slug));
  return new Map(
    result.toewijzingen
      .filter((t) => geldig.has(t.theme))
      .map((t) => [t.post_url, t.theme] as const),
  );
}

async function decodeer(teDecoderen: Outlier[], vault: VaultSnapshot): Promise<ScoutDecoded> {
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
        ...(o.transcript ? { transcript: o.transcript } : {}),
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

/**
 * De prompt eist exacte slugs, maar een string-schema dwingt niets af. Hier
 * maken we het hard: hoofdletters, spaties en koppeltekens gelijkgetrokken en
 * tegen de vault gelegd. Wat niet matcht wordt "nieuw:<tekst>", zodat retro
 * en trends het herkennen als kandidaat en niet als bestaande slug.
 */
export function normaliseerSlugs(decoded: ScoutDecoded, vault: Pick<VaultSnapshot, 'hooks' | 'structures'>): ScoutDecoded {
  const sleutel = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const hooks = new Map(vault.hooks.map((h) => [sleutel(h.slug), h.slug]));
  const structures = new Map(vault.structures.map((s) => [sleutel(s.slug), s.slug]));

  const naarSlug = (ruw: string, bekend: Map<string, string>): string => {
    const schoon = ruw.trim().replace(/^nieuw:\s*/i, '');
    const match = bekend.get(sleutel(schoon));
    if (match) return match;
    return `nieuw:${schoon}`;
  };

  return {
    ...decoded,
    posts: decoded.posts.map((p) => ({
      ...p,
      hook_type: naarSlug(p.hook_type, hooks),
      structuur: naarSlug(p.structuur, structures),
    })),
  };
}

/** Bestaande decoded-jsonb per post_url, zodat een nieuwe analyse markers van de kijk-passen niet wist. */
async function laadBestaandeDecoded(urls: string[]): Promise<Map<string, Record<string, unknown>>> {
  const uit = new Map<string, Record<string, unknown>>();
  if (urls.length === 0) return uit;
  const { data } = await db().from('scout_finds').select('post_url, decoded').in('post_url', urls);
  for (const rij of data ?? []) {
    if (rij.decoded && typeof rij.decoded === 'object') uit.set(rij.post_url as string, rij.decoded as Record<string, unknown>);
  }
  return uit;
}

/**
 * Haalt voor Shorts-vondsten zonder transcript de ondertitels op (gratis via
 * yt-dlp). Begrensd in aantal en tijd: dit is verrijking, de run mag er niet
 * op blijven hangen. TikTok-transcripten kosten een provider-credit en laten
 * we hier bewust liggen.
 */
async function vulTranscriptenAan(teDecoderen: Outlier[], fouten: { bron: string; error: string }[]): Promise<void> {
  const { fetchYoutubeCaptions } = await import('../ingest/youtube');
  let gedaan = 0;
  for (const o of teDecoderen) {
    if (gedaan >= MAX_TRANSCRIPTEN_PER_RUN) break;
    if (o.transcript || o.platform !== 'shorts' || !o.post_url) continue;
    gedaan++;
    try {
      const captions = await Promise.race([
        fetchYoutubeCaptions(o.post_url),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('transcript duurde langer dan 60s')), TRANSCRIPT_TIMEOUT_MS)),
      ]);
      if (!captions?.segments.length) continue;
      o.transcript = captions.segments
        .map((s) => s.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, MAX_TRANSCRIPT_TEKENS);
    } catch (e) {
      fouten.push({ bron: `transcript:${o.post_url}`, error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    }
  }
}

function transcriptTekst(opgeslagen: unknown): string | null {
  if (!opgeslagen || typeof opgeslagen !== 'object') return null;
  const tekst = (opgeslagen as { tekst?: unknown }).tekst;
  return typeof tekst === 'string' && tekst.trim() ? tekst : null;
}

function bronVan(gevondenVia: string): Bron {
  if (gevondenVia.startsWith('account:')) return 'account';
  if (gevondenVia.startsWith('thema:')) return 'thema';
  if (gevondenVia.startsWith('zoekterm:')) return 'zoekterm';
  return 'trending';
}

/**
 * Stelt de decodeerbatch samen met een quotum per bron (zie DECODEER_QUOTA).
 * Binnen een bron op score; blijft er ruimte over omdat een bron zijn quotum
 * niet haalt, dan vullen de andere bronnen die op score aan.
 */
export function kiesDecodeerBatch(outliers: Outlier[]): Outlier[] {
  const gesorteerd = [...outliers].sort((a, b) => b.outlier_score - a.outlier_score);
  const gekozen: Outlier[] = [];
  const teller: Record<Bron, number> = { account: 0, thema: 0, zoekterm: 0, trending: 0 };

  for (const o of gesorteerd) {
    if (teller[o.bron] >= DECODEER_QUOTA[o.bron]) continue;
    teller[o.bron]++;
    gekozen.push(o);
  }
  if (gekozen.length < DECODEER_BATCH) {
    const al = new Set(gekozen.map((o) => o.post_url));
    for (const o of gesorteerd) {
      if (gekozen.length >= DECODEER_BATCH) break;
      if (!al.has(o.post_url)) gekozen.push(o);
    }
  }
  return gekozen;
}

const PLATFORMS: Platform[] = ['shorts', 'tiktok', 'reels'];

/**
 * Binnen een resultatenset is views-per-dag de eerlijke maat; ontbreekt de
 * posttijd (zoals bij de snelle Shorts-listing, die al op deze week filtert),
 * dan zijn ruwe views binnen die set alsnog vergelijkbaar.
 */
function pakUitschieters(posts: AccountPost[], maxHits = 12) {
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

/** Valt deze post binnen het vergelijkingsvenster? Zonder datum tellen we hem mee. */
function binnenVenster(postedAt: string | null): boolean {
  if (!postedAt) return true;
  const dagen = (Date.now() - new Date(postedAt).getTime()) / (24 * 3600 * 1000);
  return dagen <= OUTLIER_VENSTER_DAGEN;
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

/** Een regel krijgt een thema als alle onderbouwende posts uit datzelfde thema komen. */
function themeVanPosts(postUrls: string[], outliers: { post_url: string; theme?: string | null }[]): string | null {
  const themas = new Set(
    postUrls.map((url) => outliers.find((o) => o.post_url === url)?.theme).filter((t): t is string => Boolean(t)),
  );
  return themas.size === 1 ? [...themas][0] : null;
}

/**
 * Schrijft kandidaat-heuristieken weg met een evidence_score van
 * aantal posts x aantal verschillende accounts. Een patroon dat bij één account
 * werkt kan toeval of format-specifiek zijn; over meerdere accounts wordt het
 * interessant. Activeren doet de retro, met de accounts erbij als bewijs.
 */
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
      evidence: { post_urls: kandidaat.post_urls, accounts: [...accounts], onderbouwing: kandidaat.onderbouwing },
    });
    if (!error) geschreven++;
    else {
      // Oudere schema's kennen de evidence-kolom niet; de regel zelf is
      // belangrijker dan het bewijs, dus nog één keer zonder.
      const { error: zonder } = await supabase.from('vault_heuristics').insert({
        rule: kandidaat.regel,
        source: 'scout_agent',
        status: 'candidate',
        evidence_score: kandidaat.post_urls.length * accounts.size,
        platform: kandidaat.platform,
        theme: themeVanPosts(kandidaat.post_urls, outliers),
      });
      if (!zonder) geschreven++;
    }
  }

  return geschreven;
}
