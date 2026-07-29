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

export type VaultSnapshot = {
  /** Waarvoor deze snapshot geldt; bepaalt welke gewichten gekozen zijn. */
  platform: string;
  theme: string;
  structures: (VaultStructure & { herkomst: string })[];
  hooks: (VaultHook & { herkomst: string })[];
  heuristics: VaultHeuristic[];
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

  const [structures, hooks, heuristics, weights] = await Promise.all([
    supabase.from('vault_structures').select('*'),
    supabase.from('vault_hooks').select('*'),
    supabase.from('vault_heuristics').select('*').eq('status', 'active'),
    loadWeights(),
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
    captured_at: new Date().toISOString(),
  };
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

  return `${context}\n\nSTRUCTUUR-ARCHETYPES (gebruik de slug exact):\n${structures}\n\nHOOK-FORMULES (gebruik de slug exact):\n${hooks}\n\nCRAFT-REGELS (altijd toepassen):\n${heuristics}`;
}

export type { WeightIndex };
