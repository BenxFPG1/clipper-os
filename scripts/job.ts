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
      const tijdelijk = /issued at future|PGRST303|fetch failed|ECONNRESET|ETIMEDOUT|AbortError|TimeoutError|aborted/i.test(
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
        `${stamp} scout${r.status === 'partial' ? ' (PARTIAL)' : ''}: ${r.accountsBekeken} accounts, ${r.zoektermen} zoektermen, ${r.outliers} uitschieters, ${r.gedecodeerd} gedecodeerd, ${r.kandidaten} nieuwe kandidaat-regels, ${r.nieuweAccounts} nieuwe accounts` +
          (r.fouten.length ? `, ${r.fouten.length} fout(en)` : '') +
          ` (run ${r.agentRunId})`,
      );
      if (r.reelsGeblokkeerd) console.log(`  reels overgeslagen: ${r.reelsGeblokkeerd.slice(0, 120)}`);
      // De fouten die de inhoud raken altijd tonen; providerfouten per bron
      // alleen de eerste paar.
      const kern = r.fouten.filter((f) => /^(decodering|themaclassificatie|opslaan:)/.test(f.bron));
      for (const f of kern) console.log(`  FOUT ${f.bron}: ${f.error.slice(0, 200)}`);
      for (const f of r.fouten.filter((f) => !kern.includes(f)).slice(0, 5)) console.log(`  fout ${f.bron}: ${f.error.slice(0, 120)}`);
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
      console.log(`${stamp} kennis: ${r.bewaard}/${r.voorstellen.length} aanvulling(en) bewaard — ${r.samenvatting.slice(0, 160)}`);
      for (const v of r.voorstellen) console.log(`  + [${v.categorie}] ${v.titel}`);
      for (const a of r.afgevallen) console.log(`  - afgevallen: ${a}`);
      break;
    }
    case 'editleraar': {
      const { runEditleraar } = await import('../src/lib/agents/editleraar');
      const r = await metRetry(() => runEditleraar());
      if (r.overgeslagen) console.log(`${stamp} editleraar: niets geleerd — ${r.overgeslagen.slice(0, 200)}`);
      else console.log(`${stamp} editleraar: ${r.regels} les(sen), ${r.kandidaten} kandidaat-effect(en) — ${r.samenvatting.slice(0, 160)}`);
      break;
    }
    case 'consolideer': {
      const { consolideerKennis } = await import('../src/lib/vault/kennis');
      const r = await metRetry(() => consolideerKennis());
      const delen = Object.entries(r.perCategorie).map(([c, s]) => `${c} ${s.voor}→${s.na} (${s.samengevoegd} samengevoegd)`);
      console.log(`${stamp} consolideer: ${delen.join(', ')}`);
      const { db } = await import('../src/lib/supabase');
      await db().from('agent_runs').insert({ agent: 'consolideer', status: 'auto', decided_by: 'auto', input_summary: r.perCategorie, proposal: r });
      break;
    }
    case 'editleraar_visueel': {
      const { runEditleraarVisueel } = await import('../src/lib/agents/editleraar');
      const r = await metRetry(() => runEditleraarVisueel());
      console.log(`${stamp} editleraar_visueel: ${r.bekeken} clip(s) bekeken, ${r.effecten} effect(en) vastgelegd`);
      for (const f of r.fouten.slice(0, 3)) console.log(`  fout: ${f}`);
      break;
    }
    case 'trends': {
      const { runTrendsAgent } = await import('../src/lib/agents/trends');
      const r = await metRetry(() => runTrendsAgent());
      if (r.overgeslagen) {
        console.log(`${stamp} trends: overgeslagen — ${r.overgeslagen}`);
        break;
      }
      console.log(
        `${stamp} trends: ${r.vondsten} vondsten → ${r.hooks} hook- en ${r.structuren} structuurpatronen, ${r.lessen} les(sen), ${r.zoektermen} nieuwe zoekterm(en)`,
      );
      console.log(`  ${r.rapport.slice(0, 300).replace(/\n+/g, ' ')}`);
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
    case 'smaak': {
      // Leerlus: eigen oordelen + eigen cijfers naast externe normen → lessen.
      const { runSmaakAgent } = await import('../src/lib/agents/smaak');
      const r = await metRetry(() => runSmaakAgent());
      if (r.overgeslagen) {
        console.log(`${stamp} smaak: overgeslagen — ${r.overgeslagen}`);
        break;
      }
      console.log(
        `${stamp} smaak: ${r.lessen.filter((l) => l.bewaard).length}/${r.lessen.length} les(sen) bewaard uit ${r.nieuweBeoordelingen} nieuwe beoordeling(en) — ${r.samenvatting.slice(0, 160)} (run ${r.agentRunId})`,
      );
      for (const l of r.lessen) console.log(`  ${l.bewaard ? '+' : '='} [${l.categorie}] ${l.titel} — ${l.bron}`);
      for (const a of r.afgevallen) console.log(`  - afgevallen: ${a}`);
      break;
    }
    case 'render_vingerafdruk': {
      // Eigen renders meetbaar maken, zodat oordelen en cijfers aan montagekenmerken te koppelen zijn.
      const { runRenderVingerafdruk } = await import('../src/lib/agents/smaak');
      const r = await metRetry(() => runRenderVingerafdruk());
      console.log(
        `${stamp} render_vingerafdruk: ${r.gedaan} gemeten, ${r.mislukt} mislukt, ${r.open} nog open` +
          (r.overgeslagen ? ` — ${r.overgeslagen}` : ''),
      );
      break;
    }
    case 'vingerafdruk': {
      // Leren van anderen: top-vondsten en basislijnposts meten, daarna de
      // edit-normen herberekenen (VINGERAFDRUK_BATCH, standaard 15 per groep).
      const { runVingerafdrukJob, vingerafdrukSamenvatting } = await import('../src/lib/analyse/vondsten');
      const r = await metRetry(() => runVingerafdrukJob());
      console.log(
        `${stamp} vingerafdruk: ${r.gemeten.top} top + ${r.gemeten.basis} basislijn gemeten, ${r.fouten.length} mislukt` +
          (r.gestoptOpTijd ? ' (gestopt op tijdsbudget)' : '') +
          ` (run ${r.agentRunId})`,
      );
      for (const f of r.fouten.slice(0, 5)) console.log(`  fout @${f.handle}: ${f.fout.slice(0, 200)}`);
      const voorbeeld = vingerafdrukSamenvatting(r.voorbeeld);
      if (voorbeeld) console.log(`  voorbeeld: ${voorbeeld.replace(/\n/g, ' | ')}`);
      if (r.normFout) console.log(`  FOUT normen: ${r.normFout.slice(0, 200)}`);
      for (const n of r.normen?.rijen ?? []) {
        console.log(`  normen ${n.platform}/${n.theme}: ${n.normen} norm(en), bron ${n.bron} (top ${n.n_top}, basis ${n.n_basis}, eigen ${n.n_eigen})`);
      }
      for (const w of r.normen?.waarschuwingen ?? []) console.log(`  let op: ${w}`);
      break;
    }
    default:
      console.error('Gebruik: npx tsx scripts/job.ts <tracking|scout|retro|kanaal|kennis|cliparmy|kijken|editleraar|editleraar_visueel|trends|consolideer|smaak|render_vingerafdruk|vingerafdruk>');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} FOUT (${process.argv[2]}):`, e instanceof Error ? e.message : e);
  process.exit(1);
});
