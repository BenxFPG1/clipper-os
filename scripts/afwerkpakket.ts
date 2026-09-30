import 'dotenv/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bouwAfwerkpakket } from '../src/lib/roughcut/afwerkpakket-bouw';
import { lijstBronCache } from '../src/lib/roughcut/broncache';
import { leesAfwerkStatus, schrijfAfwerkStatus, type AfwerkStatus } from '../src/lib/roughcut/afwerkstatus';

/**
 * "Afwerken in Premiere"-pakketten bouwen.
 *
 *   npx tsx scripts/afwerkpakket.ts --wachtrij
 *     Alles wat de site heeft klaargezet (afwerk/<render>/<clip>.json met
 *     status 'wachtend') bouwen, zippen en naar R2 zetten. Dit draait in
 *     .github/workflows/afwerkpakket.yml.
 *
 *   npx tsx scripts/afwerkpakket.ts <renderJobId> <bestand.mp4> [--map <dir>] [--zip] [--upload] [--geen-secties]
 *     Eén pakket lokaal bouwen, standaard naar ./afwerk/. Met --upload ook
 *     de zip naar R2 (en de status op 'klaar', zodat de site de link toont).
 */

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--wachtrij')) return wachtrij();

  const [renderJobId, bestandNaam] = args.filter((a) => !a.startsWith('--') && !isWaarde(args, a));
  if (!renderJobId || !bestandNaam) {
    console.log('Gebruik: npx tsx scripts/afwerkpakket.ts <renderJobId> <bestand.mp4> [--map <dir>] [--zip] [--upload] [--geen-secties]');
    process.exit(1);
  }
  const mapArg = args[args.indexOf('--map') + 1];
  const werkmap = resolve(args.includes('--map') && mapArg ? mapArg : 'afwerk');
  const upload = args.includes('--upload');
  const res = await bouwAfwerkpakket({
    renderJobId,
    bestandNaam,
    werkmap,
    haalSecties: !args.includes('--geen-secties'),
    zip: args.includes('--zip') || upload,
    upload,
    log: (m) => console.log(`  ${m}`),
  });
  if (upload && res.zipSleutel) {
    const nu = new Date().toISOString();
    await schrijfAfwerkStatus({
      status: 'klaar',
      render_job_id: renderJobId,
      bestand_naam: bestandNaam,
      aangevraagd_at: nu,
      bijgewerkt_at: nu,
      meldingen: res.meldingen,
      zip: res.zipSleutel,
      bytes: res.bytes,
    });
  }
  console.log(`\nPakket: ${res.map}`);
  for (const b of res.bestanden) console.log(`  ${b}`);
  if (res.zipPad) console.log(`Zip: ${res.zipPad} (${Math.round((res.bytes ?? 0) / 1e6)} MB)`);
  if (res.meldingen.length) console.log(`\nLet op:\n${res.meldingen.map((m) => `  - ${m}`).join('\n')}`);
}

function isWaarde(args: string[], a: string): boolean {
  const i = args.indexOf(a);
  return i > 0 && args[i - 1] === '--map';
}

/** Alle wachtende pakketten, oudste eerst. Eén mislukt pakket houdt de rest niet tegen. */
async function wachtrij() {
  const statussen = (await lijstBronCache('afwerk/')).filter((o) => o.sleutel.endsWith('.json'));
  const wachtend: AfwerkStatus[] = [];
  for (const o of statussen) {
    const [, renderJobId, bestand] = o.sleutel.match(/^afwerk\/([^/]+)\/(.+)\.json$/) ?? [];
    if (!renderJobId) continue;
    // De status bewaart de echte bestandsnaam; de sleutel alleen de basis.
    const s = await leesAfwerkStatus(renderJobId, `${bestand}.mp4`);
    if (s?.status === 'wachtend') wachtend.push(s);
  }
  wachtend.sort((a, b) => a.aangevraagd_at.localeCompare(b.aangevraagd_at));
  console.log(`${wachtend.length} afwerkpakket(ten) in de wachtrij`);

  for (const s of wachtend) {
    console.log(`\n[${s.render_job_id}] ${s.bestand_naam}`);
    const werkmap = await mkdtemp(join(tmpdir(), 'afwerk-'));
    // Statusschrijven in één keten: een late voortgangsregel mag een 'klaar'
    // nooit meer overschrijven. Voortgang hooguit elke 10 s.
    let keten: Promise<unknown> = Promise.resolve();
    const status = (x: Partial<AfwerkStatus>) => {
      keten = keten.then(() => schrijfAfwerkStatus({ ...s, ...x }).catch(() => undefined));
      return keten;
    };
    let laatsteVoortgang = 0;
    try {
      await status({ status: 'bezig', voortgang: 'bron en kaarten verzamelen…' });
      const res = await bouwAfwerkpakket({
        renderJobId: s.render_job_id,
        bestandNaam: s.bestand_naam,
        werkmap,
        haalSecties: true,
        upload: true,
        log: (m) => {
          console.log(`  ${m}`);
          if (Date.now() - laatsteVoortgang < 10_000) return;
          laatsteVoortgang = Date.now();
          void status({ status: 'bezig', voortgang: m.slice(0, 140) });
        },
      });
      await status({ status: 'klaar', voortgang: undefined, meldingen: res.meldingen, zip: res.zipSleutel, bytes: res.bytes, fout: undefined });
      console.log(`  klaar: ${res.zipSleutel} (${Math.round((res.bytes ?? 0) / 1e6)} MB)`);
    } catch (e) {
      console.log(`  mislukt: ${(e as Error).message}`);
      await status({ status: 'mislukt', voortgang: undefined, fout: (e as Error).message.slice(0, 400) });
    } finally {
      await rm(werkmap, { recursive: true, force: true });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
