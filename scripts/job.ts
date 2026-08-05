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
/**
 * Supabase weigert af en toe de eerste call met "JWT issued at future": een
 * kleine klokafwijking tussen de runner en hun servers. Het is voorbijgaand,
 * dus we proberen het een paar keer opnieuw in plaats van de hele taak te laten
 * klappen.
 */
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
      console.log(`${new Date().toISOString()} tijdelijke fout (${bericht.slice(0, 60)}), opnieuw over ${wacht / 1000}s`);
      await new Promise((r) => setTimeout(r, wacht));
    }
  }
}

async function main() {
  const job = process.argv[2];
  const stamp = new Date().toISOString();

  switch (job) {
    case 'tracking': {
      const { runTracking } = await import('../src/lib/tracking/run');
      const r = await metRetry(() => runTracking());
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
      const r = await metRetry(() => runScoutAgent());
      console.log(
        `${stamp} scout: ${r.accountsBekeken} accounts, ${r.zoektermen} zoektermen, ${r.outliers} uitschieters, ${r.kandidaten} nieuwe kandidaat-regels (run ${r.agentRunId})`,
      );
      break;
    }
    case 'retro': {
      const { runRetroAgent } = await import('../src/lib/agents/retro');
      const r = await metRetry(() => runRetroAgent());
      console.log(
        `${stamp} retro: ${r.proposal.wijzigingen.length} voorgestelde wijzigingen — ${r.proposal.samenvatting.slice(0, 160)}`,
      );
      break;
    }
    case 'cliparmy': {
      const { haalClipArmyCampagnes } = await import('../src/lib/cliparmy');
      const r = await metRetry(() => haalClipArmyCampagnes());
      console.log(
        `${stamp} cliparmy: ${r.nieuw.length} nieuwe campagne(s) uit ${r.bekeken} blok(ken)` +
          (r.fout ? ` — ${r.fout}` : ''),
      );
      for (const c of r.nieuw) console.log(`  + ${c.naam}`);
      break;
    }
    case 'kijken': {
      const { bekijkTopVondsten } = await import('../src/lib/agents/kijken');
      const r = await metRetry(() => bekijkTopVondsten());
      console.log(`${stamp} kijken: ${r.gedaan.length} clip(s) visueel geanalyseerd`);
      for (const g of r.gedaan) console.log(`  + ${g}`);
      for (const f of r.fouten.slice(0, 3)) console.log(`  fout: ${f}`);
      break;
    }
    case 'kennis': {
      const { runKennisAgent } = await import('../src/lib/agents/kennis');
      const r = await metRetry(() => runKennisAgent());
      console.log(`${stamp} kennis: ${r.voorstellen.length} aanvulling(en) — ${r.samenvatting.slice(0, 160)}`);
      for (const v of r.voorstellen) console.log(`  + [${v.categorie}] ${v.titel}`);
      break;
    }
    case 'kanaal': {
      const { haalNieuweBronvideos } = await import('../src/lib/ingest/kanaal');
      const r = await metRetry(() => haalNieuweBronvideos());
      console.log(`${stamp} kanaal: ${r.toegevoegd.length} nieuwe bronvideo('s) opgehaald`);
      for (const v of r.toegevoegd) console.log(`  + ${v.campagne}: ${v.titel}`);
      for (const f of r.fouten.slice(0, 5)) console.log(`  fout: ${f.slice(0, 160)}`);
      break;
    }
    default:
      console.error('Gebruik: npx tsx scripts/job.ts <tracking|scout|retro|kanaal|kennis|cliparmy|kijken>');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} FOUT (${process.argv[2]}):`, e instanceof Error ? e.message : e);
  process.exit(1);
});
