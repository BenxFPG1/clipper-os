import 'dotenv/config';
import { db } from '../src/lib/supabase';
import { applyRetroProposal, runRetroAgent } from '../src/lib/agents/retro';

const DECIDED_BY = 'dryrun-test';

/**
 * Dry-run van de wekelijkse retro met dummy-data (bouwdocument dag 13-14).
 *
 * Bewijst de hele leerlus: dummy-clips met performance erin, retro draait,
 * voorstel goedkeuren, vault-gewicht verandert aantoonbaar (definition of done
 * punt 3). Daarna wordt ALLES teruggedraaid — dummy-clips, changelog-regels,
 * agent-run en de gewichten zelf — zodat de vault schoon achterblijft.
 */
async function main() {
  const supabase = db();

  console.log('1. Vault-gewichten vóór de dry-run:');
  const before = await snapshotWeights();
  printWeights(before);

  // Dummy-scenario: herinterpretatie_na_reveal presteert sterk (mediaan ~2.1),
  // belofte_afstraffing zwak (mediaan ~0.4). Beide met n=6, boven de drempel.
  console.log('\n2. Dummy-clips met 7 dagen performance-data aanmaken…');
  const postedAt = new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString();
  const dummies = [
    ...scenario('herinterpretatie_na_reveal', 'vraag_aan_kijker', [1.8, 2.0, 2.1, 2.2, 2.4, 3.1]),
    ...scenario('belofte_afstraffing', 'part_teaser', [0.3, 0.35, 0.4, 0.45, 0.5, 0.6]),
  ];

  const clipIds: string[] = [];
  for (const dummy of dummies) {
    const { data: clip, error } = await supabase
      .from('clips')
      .insert({
        plan_index: 0,
        titel_intern: `DUMMY DRYRUN — niet editen`,
        structure_type: dummy.structure,
        hook_type: dummy.hook,
        status: 'posted',
        platform: 'tiktok',
        posted_at: postedAt,
        bron: 'clip',
      })
      .select()
      .single();
    if (error) throw error;
    clipIds.push(clip.id);

    const views = Math.round(10000 * dummy.outlier);
    const { error: perfError } = await supabase.from('clip_performance').insert({
      clip_id: clip.id,
      views_24h: Math.round(views * 0.4),
      views_7d: views,
      outlier_score: dummy.outlier,
      velocity_score: dummy.outlier,
    });
    if (perfError) throw perfError;
  }
  console.log(`   ${clipIds.length} dummy-clips aangemaakt.`);

  let agentRunId: string | null = null;
  try {
    console.log('\n3. Retro-agent draaien…');
    const retro = await runRetroAgent();
    agentRunId = retro.agentRunId;
    console.log(`   Samenvatting: ${retro.proposal.samenvatting}`);
    for (const w of retro.proposal.wijzigingen) {
      console.log(
        `   Voorstel: ${w.entity}/${w.slug}  ${w.huidig_gewicht.toFixed(2)} → ${w.nieuw_gewicht.toFixed(2)}  (${w.bewijs_clip_ids.length} clips als bewijs)`,
      );
    }
    if (retro.proposal.wijzigingen.length === 0) {
      throw new Error('Retro stelde niets voor — dry-run kan de goedkeuringsflow niet testen.');
    }

    console.log('\n4. Voorstel goedkeuren (zoals Antonie in de inbox zou doen)…');
    const applied = await applyRetroProposal(agentRunId, DECIDED_BY);
    console.log(`   ${applied.applied} wijziging(en) doorgevoerd.`);

    console.log('\n5. Vault-gewichten ná goedkeuring:');
    const after = await snapshotWeights();
    printWeights(after, before);

    const changed = [...after.entries()].filter(([slug, w]) => before.get(slug)?.weight !== w.weight);
    if (changed.length === 0) throw new Error('Geen gewicht veranderd — de lus werkt niet.');
    console.log(`\n   Bewijs: ${changed.length} gewichten aantoonbaar veranderd; het volgende plan zou deze gebruiken.`);
  } finally {
    console.log('\n6. Alles terugdraaien…');
    await supabase.from('clips').delete().in('id', clipIds);
    await supabase.from('vault_changelog').delete().eq('decided_by', DECIDED_BY);
    if (agentRunId) await supabase.from('agent_runs').delete().eq('id', agentRunId);
    for (const [slug, w] of before) {
      const table = w.entity === 'structure' ? 'vault_structures' : 'vault_hooks';
      await supabase.from(table).update({ weight: w.weight, version: w.version, evidence: w.evidence }).eq('slug', slug);
    }
    console.log('   Dummy-clips, changelog, agent-run en gewichten hersteld.');
  }

  console.log('\nDry-run geslaagd: de volledige leerlus werkt.');
}

function scenario(structure: string, hook: string, outliers: number[]) {
  return outliers.map((outlier) => ({ structure, hook, outlier }));
}

type WeightRow = { entity: 'structure' | 'hook'; weight: number; version: number; evidence: unknown };

async function snapshotWeights(): Promise<Map<string, WeightRow>> {
  const supabase = db();
  const [structures, hooks] = await Promise.all([
    supabase.from('vault_structures').select('slug, weight, version, evidence'),
    supabase.from('vault_hooks').select('slug, weight, version, evidence'),
  ]);
  const map = new Map<string, WeightRow>();
  for (const s of structures.data ?? []) {
    map.set(s.slug, { entity: 'structure', weight: Number(s.weight), version: s.version, evidence: s.evidence });
  }
  for (const h of hooks.data ?? []) {
    map.set(h.slug, { entity: 'hook', weight: Number(h.weight), version: h.version, evidence: h.evidence });
  }
  return map;
}

function printWeights(current: Map<string, WeightRow>, previous?: Map<string, WeightRow>) {
  for (const [slug, w] of current) {
    const prev = previous?.get(slug);
    const marker = prev && prev.weight !== w.weight ? `  (was ${prev.weight.toFixed(2)})  ←` : '';
    console.log(`   ${w.entity.padEnd(9)} ${slug.padEnd(28)} ${w.weight.toFixed(2)}${marker}`);
  }
}

main().catch((e) => {
  console.error('\nDry-run gefaald:', e instanceof Error ? e.message : e);
  process.exit(1);
});
