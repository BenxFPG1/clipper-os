import { db } from '../supabase';
import { ALL, WeightIndex, loadWeights } from './weights';

export * from './weights';
export * from './themes';

export type VaultStructure = {
  slug: string;
  name: string;
  description: string;
  template: string[];
  weight: number;
  version: number;
};

export type VaultHook = {
  slug: string;
  formula: string;
  example: string | null;
  weight: number;
  version: number;
};

export type VaultHeuristic = {
  id: string;
  rule: string;
  source: string;
  status: string;
  platform: string | null;
  theme?: string | null;
};

/**
 * De harde tellingen uit het laatste trendrapport: welke hooks en structuren
 * de afgelopen periode bij de meeste verschillende accounts terugkwamen.
 * Dit is geen gewicht (dat blijft de retro bepalen) maar context: "dit zie
 * je nú overal", zodat planner en scriptwriter het meewegen.
 */
export type VaultTrends = {
  periodeDagen: number;
  datum: string;
  hooks: { slug: string; accounts: number; posts: number }[];
  structuren: { slug: string; accounts: number; posts: number }[];
};

export type VaultSnapshot = {
  /** Waarvoor deze snapshot geldt; bepaalt welke gewichten gekozen zijn. */
  platform: string;
  theme: string;
  structures: (VaultStructure & { herkomst: string })[];
  hooks: (VaultHook & { herkomst: string })[];
  heuristics: VaultHeuristic[];
  /** Ontbreekt zolang er nog geen trendrapport is. */
  trends?: VaultTrends;
  captured_at: string;
};

export type VaultContext = { platform?: string | null; theme?: string | null };

/**
 * Laadt de vault zoals hij geldt voor één platform en thema. De definities
 * (beats, formules) zijn gedeeld tussen alle accounts; alleen de gewichten
 * verschillen per combinatie. Deze snapshot gaat mee in clip_plans en
 * brief_scripts, zodat elk plan reproduceerbaar blijft.
 */
export async function loadVault(context: VaultContext = {}): Promise<VaultSnapshot> {
  const supabase = db();
  const platform = context.platform ?? ALL;
  const theme = context.theme ?? ALL;

  const [structures, hooks, heuristics, weights, trends] = await Promise.all([
    supabase.from('vault_structures').select('*'),
    supabase.from('vault_hooks').select('*'),
    supabase.from('vault_heuristics').select('*').eq('status', 'active'),
    loadWeights(),
    laadTrends(platform, theme),
  ]);

  if (structures.error) throw structures.error;
  if (hooks.error) throw hooks.error;
  if (heuristics.error) throw heuristics.error;

  const gewogenStructures = (structures.data ?? [])
    .map((s) => {
      const { weight, herkomst } = weights.resolve('structure', s.slug, platform, theme);
      return { ...(s as VaultStructure), weight, herkomst };
    })
    .sort((a, b) => b.weight - a.weight);

  const gewogenHooks = (hooks.data ?? [])
    .map((h) => {
      const { weight, herkomst } = weights.resolve('hook', h.slug, platform, theme);
      return { ...(h as VaultHook), weight, herkomst };
    })
    .sort((a, b) => b.weight - a.weight);

  // Craft-regels gelden breed, maar een regel die aan één platform of thema
  // hangt laten we alleen meedoen als die context past.
  const passendeHeuristieken = ((heuristics.data ?? []) as VaultHeuristic[]).filter((h) => {
    const platformOk = !h.platform || platform === ALL || h.platform === platform;
    const themeOk = !h.theme || theme === ALL || h.theme === theme;
    return platformOk && themeOk;
  });

  return {
    platform,
    theme,
    structures: gewogenStructures,
    hooks: gewogenHooks,
    heuristics: passendeHeuristieken,
    ...(trends ? { trends } : {}),
    captured_at: new Date().toISOString(),
  };
}

type TrendRijRuw = {
  sleutel: string;
  aantal: number;
  accounts: number;
  platforms?: Record<string, number>;
  themas?: Record<string, number>;
};

/**
 * Top-5 hooks en structuren uit het laatste trendrapport. Past de selectie
 * aan op platform en thema als daar tellingen voor zijn; anders de brede
 * ranking. Slugs met "nieuw:" blijven buiten beeld: die bestaan nog niet in
 * de vault en de planner mag ze niet gebruiken. Faalt dit (geen tabel, geen
 * rapport), dan gewoon geen trends — de vault werkt ook zonder.
 */
async function laadTrends(platform: string, theme: string): Promise<VaultTrends | null> {
  try {
    const { data } = await db()
      .from('trend_rapporten')
      .select('rankings, periode_dagen, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data?.rankings) return null;
    const rankings = data.rankings as { hooks?: TrendRijRuw[]; structuren?: TrendRijRuw[] };

    const kies = (rijen: TrendRijRuw[] | undefined) => {
      const bruikbaar = (rijen ?? []).filter((r) => !r.sleutel.startsWith('nieuw:'));
      const past = bruikbaar.filter(
        (r) =>
          (platform === ALL || (r.platforms?.[platform] ?? 0) > 0) && (theme === ALL || (r.themas?.[theme] ?? 0) > 0),
      );
      return (past.length >= 3 ? past : bruikbaar)
        .slice(0, 5)
        .map((r) => ({ slug: r.sleutel, accounts: r.accounts, posts: r.aantal }));
    };

    return {
      periodeDagen: (data.periode_dagen as number | null) ?? 30,
      datum: new Date(data.created_at as string).toLocaleDateString('nl-NL'),
      hooks: kies(rankings.hooks),
      structuren: kies(rankings.structuren),
    };
  } catch {
    return null;
  }
}

/** Compacte tekstweergave van de vault voor in de planner-prompt. */
export function renderVaultForPrompt(vault: VaultSnapshot): string {
  const context =
    vault.platform === ALL && vault.theme === ALL
      ? 'Deze gewichten gelden algemeen (nog geen platform- of themaspecifieke data).'
      : `Deze gewichten gelden voor platform "${vault.platform}" en thema "${vault.theme}". ` +
        `Waar we voor die combinatie nog te weinig data hebben, val je terug op bredere cijfers.`;

  const structures = vault.structures
    .map(
      (s) =>
        `- ${s.slug} (gewicht ${s.weight.toFixed(2)}, bron: ${s.herkomst}): ${s.description} Beats: ${s.template.join(' → ')}`,
    )
    .join('\n');
  const hooks = vault.hooks
    .map(
      (h) =>
        `- ${h.slug} (gewicht ${h.weight.toFixed(2)}, bron: ${h.herkomst}): ${h.formula}${h.example ? ` Voorbeeld: "${h.example}"` : ''}`,
    )
    .join('\n');
  const heuristics = vault.heuristics.map((h) => `- ${h.rule}`).join('\n');

  const t = vault.trends;
  const trends =
    t && (t.hooks.length > 0 || t.structuren.length > 0)
      ? `\n\nAFGELOPEN ${t.periodeDagen} DAGEN BEST PRESTEREND BIJ ANDERE ACCOUNTS (trendrapport ${t.datum}; context, geen verplichting — de gewichten hierboven blijven leidend):\n` +
        `Hooks: ${t.hooks.map((h) => `${h.slug} (${h.accounts} accounts, ${h.posts} posts)`).join(', ') || '—'}\n` +
        `Structuren: ${t.structuren.map((s) => `${s.slug} (${s.accounts} accounts, ${s.posts} posts)`).join(', ') || '—'}`
      : '';

  return `${context}\n\nSTRUCTUUR-ARCHETYPES (gebruik de slug exact):\n${structures}\n\nHOOK-FORMULES (gebruik de slug exact):\n${hooks}\n\nCRAFT-REGELS (altijd toepassen):\n${heuristics}${trends}`;
}

export type { WeightIndex };
