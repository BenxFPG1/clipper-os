import 'dotenv/config';
import { db } from '../src/lib/supabase';
import { SEED_CAMPAIGN, SEED_HEURISTICS, SEED_HOOKS, SEED_STRUCTURES } from '../src/lib/vault/seed-data';

/**
 * Laadt de vault-seed en de voorbeeldcampagne. Idempotent: bestaande gewichten
 * blijven staan, zodat opnieuw seeden nooit het leerwerk van de Retro-agent wist.
 */
async function main() {
  const supabase = db();

  const { data: existingStructures } = await supabase.from('vault_structures').select('slug');
  const knownStructures = new Set((existingStructures ?? []).map((s) => s.slug));
  const newStructures = SEED_STRUCTURES.filter((s) => !knownStructures.has(s.slug));
  if (newStructures.length > 0) {
    const { error } = await supabase.from('vault_structures').insert(
      newStructures.map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description,
        template: s.template,
        weight: 0.5,
        evidence: {},
        version: 1,
      })),
    );
    if (error) throw error;
  }
  console.log(`Structuren: ${newStructures.length} toegevoegd, ${knownStructures.size} ongemoeid gelaten.`);

  const { data: existingHooks } = await supabase.from('vault_hooks').select('slug');
  const knownHooks = new Set((existingHooks ?? []).map((h) => h.slug));
  const newHooks = SEED_HOOKS.filter((h) => !knownHooks.has(h.slug));
  if (newHooks.length > 0) {
    const { error } = await supabase.from('vault_hooks').insert(
      newHooks.map((h) => ({
        slug: h.slug,
        formula: h.formula,
        example: h.example,
        weight: 0.5,
        evidence: {},
        version: 1,
      })),
    );
    if (error) throw error;
  }
  console.log(`Hooks: ${newHooks.length} toegevoegd, ${knownHooks.size} ongemoeid gelaten.`);

  const { data: existingRules } = await supabase.from('vault_heuristics').select('rule');
  const knownRules = new Set((existingRules ?? []).map((r) => r.rule));
  const newRules = SEED_HEURISTICS.filter((r) => !knownRules.has(r));
  if (newRules.length > 0) {
    const { error } = await supabase
      .from('vault_heuristics')
      .insert(newRules.map((rule) => ({ rule, source: 'manual', status: 'active', evidence_score: 0 })));
    if (error) throw error;
  }
  console.log(`Craft-regels: ${newRules.length} toegevoegd, ${knownRules.size} ongemoeid gelaten.`);

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id')
    .eq('name', SEED_CAMPAIGN.name)
    .maybeSingle();
  if (!campaign) {
    const { error } = await supabase.from('campaigns').insert(SEED_CAMPAIGN);
    if (error) throw error;
    console.log(`Campagne "${SEED_CAMPAIGN.name}" aangemaakt.`);
  } else {
    console.log(`Campagne "${SEED_CAMPAIGN.name}" bestond al.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
