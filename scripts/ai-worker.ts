import 'dotenv/config';
import { db } from '../src/lib/supabase';
import { runPlannerForVideo } from '../src/lib/planner/run';
import { runScriptwriterForBrief } from '../src/lib/scriptwriter';
import { bedenkConcepten } from '../src/lib/concepten';

/**
 * Voert wachtende denkopdrachten uit met de abonnements-token. De live site kan
 * dit niet zelf (geen Claude-CLI op serverless), dus zet daar alles in de
 * wachtrij; deze worker draait in GitHub Actions.
 *
 *   npx tsx scripts/ai-worker.ts
 */
async function main() {
  const supabase = db();

  const { data: jobs, error } = await supabase
    .from('ai_jobs')
    .select('*')
    .eq('status', 'wachtend')
    .order('created_at')
    .limit(10);
  if (error) throw error;

  if (!jobs?.length) {
    console.log('Geen wachtende denkopdrachten.');
    return;
  }

  console.log(`${jobs.length} opdracht(en) te doen.`);

  for (const job of jobs) {
    console.log(`\n[${job.soort}] ${job.doel_id}`);
    await supabase
      .from('ai_jobs')
      .update({ status: 'bezig', gestart_at: new Date().toISOString() })
      .eq('id', job.id);

    try {
      const params = (job.parameters ?? {}) as { aantal?: number; reuse_character_map?: boolean };
      let resultaat: unknown;

      if (job.soort === 'clip_plan') {
        const r = await runPlannerForVideo(job.doel_id, {
          reuseCharacterMap: params.reuse_character_map ?? false,
        });
        resultaat = { clips: (r.plan as { clips?: unknown[] })?.clips?.length ?? 0 };
      } else if (job.soort === 'scripts') {
        const r = await runScriptwriterForBrief(job.doel_id, params.aantal ?? 3);
        resultaat = { varianten: r.varianten.length };
      } else if (job.soort === 'concepten') {
        const r = await bedenkConcepten(job.doel_id, params.aantal ?? 8);
        resultaat = { concepten: r.length };
      } else {
        throw new Error(`Onbekende soort: ${job.soort}`);
      }

      await supabase
        .from('ai_jobs')
        .update({ status: 'klaar', resultaat, klaar_at: new Date().toISOString() })
        .eq('id', job.id);
      console.log('  klaar:', JSON.stringify(resultaat));
    } catch (e) {
      const fout = e instanceof Error ? e.message : String(e);
      await supabase
        .from('ai_jobs')
        .update({ status: 'mislukt', fout: fout.slice(0, 2000), klaar_at: new Date().toISOString() })
        .eq('id', job.id);
      console.error('  mislukt:', fout.slice(0, 300));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
