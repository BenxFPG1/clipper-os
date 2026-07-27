import 'dotenv/config';
import { runEvalAgent } from '../src/lib/agents/eval';

/**
 * Poort voor prompt- en vault-wijzigingen. Exit-code 1 bij een gefaalde case,
 * zodat dit in CI of een pre-deploy hook kan hangen (sectie 13).
 */
async function main() {
  const { passed, results } = await runEvalAgent();

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
