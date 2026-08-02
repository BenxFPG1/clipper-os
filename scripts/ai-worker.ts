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
/** Hoeveel opdrachten tegelijk. Twee is een veilige balans met de sessielimiet. */
const GELIJKTIJDIG = Number(process.env.AI_JOBS_GELIJKTIJDIG ?? 2);

async function main() {
  const supabase = db();

  // Een run kan onderweg afgebroken worden (annulering, tijdslimiet). De
  // opdracht blijft dan op 'bezig' staan en zou nooit meer opgepakt worden.
  // Alles wat langer dan een uur 'bezig' is, mag opnieuw.
  const grens = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: vastgelopen } = await supabase
    .from('ai_jobs')
    .update({ status: 'wachtend', gestart_at: null })
    .eq('status', 'bezig')
    .lt('gestart_at', grens)
    .select('id');
  if (vastgelopen?.length) {
    console.log(`${vastgelopen.length} vastgelopen opdracht(en) teruggezet in de wachtrij.`);
  }

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

  console.log(`${jobs.length} opdracht(en) te doen, ${GELIJKTIJDIG} tegelijk.`);

  // Meerdere opdrachten tegelijk: het wachten zit in de Claude-calls, niet in
  // rekenkracht hier. Bij een sessielimiet zetten we de vlag en stopt alles.
  let limietGeraakt = false;

  const verwerk = async (job: (typeof jobs)[number]) => {
    if (limietGeraakt) return;
    console.log(`[${job.soort}] ${job.doel_id}`);
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

      // Een sessie- of ratelimiet is tijdelijk: de opdracht terug in de
      // wachtrij en stoppen met deze run. Doorgaan zou de rest van de
      // wachtrij op dezelfde limiet laten stuklopen en als 'mislukt'
      // wegschrijven, terwijl er niets mis is met het werk zelf.
      const limiet = /session limit|usage limit|rate.?limit|quota|resets? \d/i.test(fout);
      if (limiet) {
        const pogingen = ((job.pogingen as number | null) ?? 0) + 1;
        await supabase
          .from('ai_jobs')
          .update({
            status: pogingen >= 20 ? 'mislukt' : 'wachtend',
            pogingen,
            fout: fout.slice(0, 500),
            gestart_at: null,
          })
          .eq('id', job.id);
        console.log(`  limiet bereikt (poging ${pogingen}) — terug in de wachtrij, run stopt hier.`);
        console.log(`  ${fout.slice(0, 160)}`);
        limietGeraakt = true;
        return;
      }

      await supabase
        .from('ai_jobs')
        .update({ status: 'mislukt', fout: fout.slice(0, 2000), klaar_at: new Date().toISOString() })
        .eq('id', job.id);
      console.error('  mislukt:', fout.slice(0, 300));
    }
  };

  // In groepjes: zo blijft de logging leesbaar en stopt een limiet snel.
  for (let i = 0; i < jobs.length && !limietGeraakt; i += GELIJKTIJDIG) {
    await Promise.all(jobs.slice(i, i + GELIJKTIJDIG).map(verwerk));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
