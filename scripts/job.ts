import 'dotenv/config';

/**
 * Draait één achtergrondtaak zonder webserver, voor launchd op de Mac:
 *
 *   npx tsx scripts/job.ts tracking   # views van geposte clips + performance
 *   npx tsx scripts/job.ts scout      # research: accounts + zoektermen
 *   npx tsx scripts/job.ts retro      # wekelijks vault-voorstel
 *
 * Elke run logt één regel naar stdout; launchd schrijft die naar
 * ~/Library/Logs/clipper-os/. Fouten geven exit-code 1 zodat je ze in de log
 * herkent, maar een taak die inhoudelijk niets te doen heeft is gewoon succes.
 */
async function main() {
  const job = process.argv[2];
  const stamp = new Date().toISOString();

  switch (job) {
    case 'tracking': {
      const { runTracking } = await import('../src/lib/tracking/run');
      const r = await runTracking();
      console.log(
        `${stamp} tracking: ${r.succeeded}/${r.attempted} clips gemeten, performance voor ${r.performanceUpdated} bijgewerkt` +
          (r.failed.length ? `, ${r.failed.length} mislukt` : '') +
          (r.costAlert ? ` — LET OP: ${r.costAlert}` : ''),
      );
      for (const f of r.failed.slice(0, 3)) console.log(`  mislukt: ${f.clipId} — ${f.error.slice(0, 120)}`);
      break;
    }
    case 'scout': {
      const { runScoutAgent } = await import('../src/lib/agents/scout');
      const r = await runScoutAgent();
      console.log(
        `${stamp} scout: ${r.accountsBekeken} accounts, ${r.zoektermen} zoektermen, ${r.outliers} uitschieters, ${r.kandidaten} nieuwe kandidaat-regels (run ${r.agentRunId})`,
      );
      break;
    }
    case 'retro': {
      const { runRetroAgent } = await import('../src/lib/agents/retro');
      const r = await runRetroAgent();
      console.log(
        `${stamp} retro: ${r.proposal.wijzigingen.length} voorgestelde wijzigingen — ${r.proposal.samenvatting.slice(0, 160)}`,
      );
      break;
    }
    default:
      console.error('Gebruik: npx tsx scripts/job.ts <tracking|scout|retro>');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} FOUT (${process.argv[2]}):`, e instanceof Error ? e.message : e);
  process.exit(1);
});
