import 'dotenv/config';
import { runEvalAgent } from '../src/lib/agents/eval';

/**
 * Poort voor prompt- en vault-wijzigingen. Exit-code 1 bij een gefaalde case,
 * zodat dit in CI of een pre-deploy hook kan hangen (sectie 13).
 */
/** Zelfde als in job.ts: voorbijgaande Supabase-klokfouten niet fataal laten zijn. */
async function metRetry<T>(fn: () => Promise<T>, pogingen = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const bericht = e instanceof Error ? e.message : String(e);
      const tijdelijk = /issued at future|PGRST303|fetch failed|ECONNRESET|ETIMEDOUT/i.test(
        bericht + JSON.stringify(e),
      );
      if (!tijdelijk || i >= pogingen - 1) throw e;
      const wacht = 15_000 * (i + 1);
      console.log(`tijdelijke fout (${bericht.slice(0, 60)}), opnieuw over ${wacht / 1000}s`);
      await new Promise((r) => setTimeout(r, wacht));
    }
  }
}

async function main() {
  const { passed, results } = await metRetry(() => runEvalAgent());

  for (const result of results) {
    console.log(`\n${result.passed ? 'PASS' : 'FAIL'}  ${result.name}`);
    for (const check of result.checks) {
      console.log(`  ${check.passed ? '✓' : '✗'} ${check.check}: ${check.detail}`);
    }
  }

  if (results.length === 0) {
    console.log('\nGeen eval-cases gevonden. Draai eerst scripts/seed-eval-case.ts.');
    process.exit(1);
  }

  console.log(`\n${passed ? 'Alle cases geslaagd.' : 'Er zijn cases gefaald — wijziging niet live zetten.'}`);
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
