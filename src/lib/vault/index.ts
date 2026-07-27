import { db } from '../supabase';

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
};

export type VaultSnapshot = {
  structures: VaultStructure[];
  hooks: VaultHook[];
  heuristics: VaultHeuristic[];
  captured_at: string;
};

/** Laadt de actuele vault. Deze snapshot gaat mee in clip_plans voor reproduceerbaarheid. */
export async function loadVault(): Promise<VaultSnapshot> {
  const supabase = db();
  const [structures, hooks, heuristics] = await Promise.all([
    supabase.from('vault_structures').select('*').order('weight', { ascending: false }),
    supabase.from('vault_hooks').select('*').order('weight', { ascending: false }),
    supabase.from('vault_heuristics').select('*').eq('status', 'active'),
  ]);

  if (structures.error) throw structures.error;
  if (hooks.error) throw hooks.error;
  if (heuristics.error) throw heuristics.error;

  return {
    structures: (structures.data ?? []) as VaultStructure[],
    hooks: (hooks.data ?? []) as VaultHook[],
    heuristics: (heuristics.data ?? []) as VaultHeuristic[],
    captured_at: new Date().toISOString(),
  };
}

/** Compacte tekstweergave van de vault voor in de planner-prompt. */
export function renderVaultForPrompt(vault: VaultSnapshot): string {
  const structures = vault.structures
    .map((s) => `- ${s.slug} (gewicht ${s.weight.toFixed(2)}): ${s.description} Beats: ${s.template.join(' → ')}`)
    .join('\n');
  const hooks = vault.hooks
    .map((h) => `- ${h.slug} (gewicht ${h.weight.toFixed(2)}): ${h.formula}${h.example ? ` Voorbeeld: "${h.example}"` : ''}`)
    .join('\n');
  const heuristics = vault.heuristics.map((h) => `- ${h.rule}`).join('\n');

  return `STRUCTUUR-ARCHETYPES (gebruik de slug exact):\n${structures}\n\nHOOK-FORMULES (gebruik de slug exact):\n${hooks}\n\nCRAFT-REGELS (altijd toepassen):\n${heuristics}`;
}
