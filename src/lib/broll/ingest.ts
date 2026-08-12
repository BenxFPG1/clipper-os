import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { db } from '../supabase';
import { analyseerBroll } from './analyse';
import { bekijkBroll, type KijkOordeel } from './kijk';

/**
 * B-roll binnenhalen uit een gedeelde Google Drive-map.
 *
 * De campagne levert geen lange bronvideo maar een map losse shots. Die halen
 * we één keer op (gdown kan publieke "iedereen met de link"-mappen zonder
 * API-sleutel), analyseren we (scènes, beweging, duur) en zetten we in onze
 * eigen opslag — vanaf dat moment is de Drive-link niet meer nodig en rendert
 * de cloud vanuit dezelfde bucket als altijd.
 *
 * Elk bestand wordt een eigen videos-rij met soort 'broll': zo liften ze mee
 * op alles wat er al is (campagnekoppeling, archiveren, render_jobs).
 */

const BUCKET = 'montages';
const VIDEO_EXTENSIES = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
/** Groter dan dit uploaden we niet; één b-roll-shot hoort geen gigabyte te zijn. */
const MAX_BESTAND_BYTES = 400 * 1024 * 1024;

export type IngestResultaat = {
  toegevoegd: { videoId: string; naam: string; duur: number }[];
  overgeslagen: string[];
  fouten: string[];
};

export async function haalBrollUitDrive(campaignId: string, driveUrl: string): Promise<IngestResultaat> {
  const supabase = db();
  const resultaat: IngestResultaat = { toegevoegd: [], overgeslagen: [], fouten: [] };

  await controleerGdown();

  const werkmap = await mkdtemp(join(tmpdir(), 'clipper-broll-'));
  try {
    // gdown haalt de hele map op; --remaining-ok voorkomt dat hij stopt bij
    // mappen met meer dan 50 bestanden.
    await run('gdown', ['--folder', driveUrl, '-O', werkmap, '--remaining-ok'], 15 * 60 * 1000);

    const bestanden = await verzamelVideos(werkmap);
    if (bestanden.length === 0) {
      throw new Error('Geen videobestanden gevonden in de Drive-map. Is de map openbaar ("iedereen met de link")?');
    }

    // Wat er al is (zelfde bestandsnaam binnen deze campagne) slaan we over:
    // opnieuw ophalen mag geen duplicaten opleveren.
    const { data: bestaand } = await supabase
      .from('videos')
      .select('title')
      .eq('campaign_id', campaignId)
      .eq('soort', 'broll');
    const bekend = new Set((bestaand ?? []).map((v) => v.title as string));

    // Eerst alles mechanisch analyseren, dan in één keer laten bekíjken
    // (gebatcht vision), dan pas uploaden. De kijk-laag is wat de planner in
    // staat stelt shots te combineren die bij elkaar passen: categorie, sfeer,
    // kleuren en tags per shot.
    const nieuwe = bestanden
      .map((pad) => ({ pad, naam: pad.slice(werkmap.length + 1).replace(/\//g, ' - ') }))
      .filter((b) => {
        if (bekend.has(b.naam)) {
          resultaat.overgeslagen.push(b.naam);
          return false;
        }
        return true;
      });

    const analyses = new Map<string, Awaited<ReturnType<typeof analyseerBroll>>>();
    for (const b of nieuwe) {
      try {
        analyses.set(b.pad, await analyseerBroll(b.pad));
      } catch (e) {
        resultaat.fouten.push(`${b.naam}: analyse mislukt (${e instanceof Error ? e.message : e})`);
      }
    }
    const geanalyseerd = nieuwe.filter((b) => analyses.has(b.pad));
    let kijk: (KijkOordeel | null)[] = geanalyseerd.map(() => null);
    try {
      kijk = await bekijkBroll(
        geanalyseerd.map((b) => ({ pad: b.pad, duur: analyses.get(b.pad)!.duur })),
        werkmap,
      );
    } catch (e) {
      resultaat.fouten.push(`kijk-agent overgeslagen: ${e instanceof Error ? e.message : e}`);
    }

    for (const [i, { pad, naam }] of geanalyseerd.entries()) {
      try {
        const { size } = await stat(pad);
        if (size > MAX_BESTAND_BYTES) {
          resultaat.fouten.push(`${naam}: ${Math.round(size / 1e6)}MB is te groot`);
          continue;
        }

        const analyse = { ...analyses.get(pad)!, kijk: kijk[i] ?? undefined };

        // Bucket-les van eerder: alleen video/mp4 wordt geaccepteerd, dus dat
        // contentType gebruiken we ongeacht de echte container.
        const opslagPad = `broll/${campaignId}/${naam.replace(/[^\w.\- ]+/g, '_')}`;
        const { error: uploadFout } = await supabase.storage
          .from(BUCKET)
          .upload(opslagPad, await readFile(pad), { contentType: 'video/mp4', upsert: true });
        if (uploadFout) throw new Error(`upload: ${uploadFout.message}`);

        const { data: rij, error: insertFout } = await supabase
          .from('videos')
          .insert({
            campaign_id: campaignId,
            title: naam,
            source_url: `storage:${opslagPad}`,
            duration_seconds: Math.round(analyse.duur),
            soort: 'broll',
            broll_analyse: analyse,
            auto_toegevoegd: true,
          })
          .select('id')
          .single();
        if (insertFout) throw new Error(insertFout.message);

        resultaat.toegevoegd.push({ videoId: rij.id as string, naam, duur: analyse.duur });
      } catch (e) {
        resultaat.fouten.push(`${naam}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return resultaat;
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }
}

async function verzamelVideos(map: string): Promise<string[]> {
  const uit: string[] = [];
  for (const item of await readdir(map, { withFileTypes: true, recursive: true })) {
    if (!item.isFile()) continue;
    if (!VIDEO_EXTENSIES.has(extname(item.name).toLowerCase())) continue;
    uit.push(join(item.parentPath ?? (item as { path?: string }).path ?? map, item.name));
  }
  return uit.sort();
}

async function controleerGdown(): Promise<void> {
  try {
    await run('gdown', ['--version'], 15_000);
  } catch {
    throw new Error(
      'gdown is niet geïnstalleerd (nodig om een Drive-map op te halen). Installeer met: pip3 install gdown',
    );
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const kind = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      kind.kill('SIGKILL');
      reject(new Error(`${cmd} duurde langer dan ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    kind.stdout.on('data', (d) => (stdout += d));
    kind.stderr.on('data', (d) => (stderr += d));
    kind.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    kind.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/** Haalt een b-roll-bestand uit de opslag naar een lokaal pad (voor renderen). */
export async function downloadBroll(opslagPad: string, naarPad: string): Promise<void> {
  const supabase = db();
  const { data, error } = await supabase.storage.from(BUCKET).download(opslagPad.replace(/^storage:/, ''));
  if (error || !data) throw new Error(`download ${opslagPad}: ${error?.message ?? 'leeg'}`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(naarPad, Buffer.from(await data.arrayBuffer()));
  if (!existsSync(naarPad)) throw new Error(`download ${opslagPad}: bestand niet geschreven`);
  void createReadStream;
}
