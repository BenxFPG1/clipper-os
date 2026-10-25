import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { db } from '../supabase';
import { bewaarInBronCache, bronSleutel as cacheSleutel, haalUitBronCache, lijstBronCache, markeerBlijvend } from '../roughcut/broncache';
import { mijnEnergie } from '../planner/energie';
import { bronSleutel, herkenBron, titelUitBestandsnaam, wetransferBestandUrl } from './bron-url';
import {
  BronFout,
  type BronBestand,
  downloadDriveBestand,
  downloadWeTransferBestanden,
  heeftRenderKwaliteit,
  lijstBronBestanden,
  maakAnalyseKopie,
  mb,
  type VideoMeting,
} from './bronnen';
import { GeenSpraakError, transcribeLocalFile } from './whisper';

/**
 * Een Drive- of WeTransfer-bron binnenhalen als video's van een campagne.
 *
 * Per video: downloaden, een analysekopie maken (≤1080p H.264), zelf
 * transcriberen (geen captions bij deze bronnen), de energiemomenten meten
 * nu de audio er toch staat, een videos-rij aanmaken en de bron in de
 * R2-broncache zetten (bron/<videoId>/analyse.mp4, plus het origineel als
 * renderbron als dat scherper is). Vanaf dan heeft niemand de Drive-map of
 * de — na een week verlopen — WeTransfer nog nodig: de render-worker haalt
 * alles uit R2.
 */

export type DirecteBronResultaat = {
  toegevoegd: { videoId: string; titel: string }[];
  fouten: string[];
  /** Al bekend (zelfde bron-URL in de campagne). */
  overgeslagen: number;
  /** Nog niet gedaan door de grens per run; komt de volgende run. */
  resterend: number;
};

export async function haalDirecteBronBinnen(opties: {
  campaignId: string;
  bron: string;
  /** Bronsleutels (bron-url.ts) die de campagne al heeft; wordt bijgewerkt. */
  bekend?: Set<string>;
  /**
   * Mag er nog een video bij (grens per run)? Krijgt mee hoeveel deze aanroep
   * er zelf al heeft toegevoegd: de aanroeper telt die pas na afloop mee.
   */
  magNog?: (alToegevoegd: number) => boolean;
  autoPlan?: boolean;
  /** Titel voor een enkel bestand (handmatig opgegeven). */
  titel?: string | null;
  log?: (m: string) => void;
}): Promise<DirecteBronResultaat> {
  const supabase = db();
  const log = opties.log ?? ((m: string) => console.log(`  ${m}`));
  const magNog = opties.magNog ?? (() => true);
  const resultaat: DirecteBronResultaat = { toegevoegd: [], fouten: [], overgeslagen: 0, resterend: 0 };

  const bekend = opties.bekend ?? (await bekendeBronnen(opties.campaignId));

  const bestanden = await lijstBronBestanden(opties.bron);
  const nieuw = bestanden.filter((b) => {
    const sleutel = bronSleutel(b.bronUrl);
    if (sleutel && bekend.has(sleutel)) {
      resultaat.overgeslagen++;
      return false;
    }
    return true;
  });
  log(`${opties.bron}: ${bestanden.length} video('s), ${nieuw.length} nieuw`);

  for (const [i, bestand] of nieuw.entries()) {
    if (!magNog(resultaat.toegevoegd.length)) {
      resultaat.resterend = nieuw.length - i;
      break;
    }
    const werkmap = await mkdtemp(join(tmpdir(), 'clipper-directe-bron-'));
    try {
      log(`[${i + 1}/${nieuw.length}] ${bestand.naam}${bestand.bytes ? ` (${Math.round(bestand.bytes / 1e6)} MB)` : ''} ophalen…`);
      for (const deel of await downloadDelen(bestand, join(werkmap, 'download'), log)) {
        const sleutel = bronSleutel(deel.bronUrl);
        if (sleutel && bekend.has(sleutel)) {
          resultaat.overgeslagen++;
          continue;
        }
        try {
          const titel = nieuw.length === 1 && opties.titel ? opties.titel : deel.titel;
          const videoId = await verwerkBestand({
            campaignId: opties.campaignId,
            pad: deel.pad,
            bronUrl: deel.bronUrl,
            titel,
            werkmap,
            autoPlan: opties.autoPlan !== false,
            log,
          });
          if (sleutel) bekend.add(sleutel);
          resultaat.toegevoegd.push({ videoId, titel });
        } catch (e) {
          resultaat.fouten.push(`${deel.titel}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          await rm(deel.pad, { force: true });
        }
      }
    } catch (e) {
      resultaat.fouten.push(`${bestand.titel}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await rm(werkmap, { recursive: true, force: true });
    }
  }
  return resultaat;
}

/** Bronsleutels van alle video's (ook gearchiveerd) van een campagne. */
export async function bekendeBronnen(campaignId: string): Promise<Set<string>> {
  const { data } = await db().from('videos').select('source_url').eq('campaign_id', campaignId);
  return new Set((data ?? []).map((v) => bronSleutel(v.source_url as string | null)).filter((s): s is string => Boolean(s)));
}

/**
 * Downloadt één bestand uit de lijst. Een zip in een WeTransfer levert
 * meerdere video's op, elk met een eigen bron-URL (…&pad=<pad in de zip>).
 */
async function downloadDelen(
  bestand: BronBestand,
  map: string,
  log: (m: string) => void,
): Promise<{ pad: string; bronUrl: string; titel: string }[]> {
  const b = herkenBron(bestand.bronUrl);
  if (b.soort === 'drive_bestand') {
    return [{ pad: await downloadDriveBestand(b.id, map, log), bronUrl: bestand.bronUrl, titel: bestand.titel }];
  }
  if (b.soort === 'wetransfer') {
    const paden = await downloadWeTransferBestanden(b, map, log);
    const uitZip = paden.length > 1 || paden.some((p) => p.includes(`${join(map, 'zip')}/`));
    return paden.map((pad) => {
      if (!uitZip) return { pad, bronUrl: bestand.bronUrl, titel: bestand.titel };
      const binnen = relative(join(map, 'zip'), pad);
      return {
        pad,
        bronUrl: wetransferBestandUrl(b.transferId, b.hash, b.bestandId ?? 'transfer', b.via, binnen),
        titel: titelUitBestandsnaam(binnen.replace(/\//g, ' - ')),
      };
    });
  }
  throw new BronFout(`Geen Drive- of WeTransfer-bestand: ${bestand.bronUrl}`, 'niet_gevonden');
}

async function verwerkBestand(o: {
  campaignId: string;
  pad: string;
  bronUrl: string;
  titel: string;
  werkmap: string;
  autoPlan: boolean;
  log: (m: string) => void;
}): Promise<string> {
  const supabase = db();
  const analyse = join(o.werkmap, 'analyse.mp4');
  o.log(`gedownload: ${await mb(o.pad)} MB`);
  const meting = await maakAnalyseKopie(o.pad, analyse, o.log);

  const t0 = Date.now();
  o.log(`transcriberen (${Math.round(meting.duur / 60)} min)…`);
  let segments;
  let geenSpraak = false;
  try {
    segments = await transcribeLocalFile(analyse, { log: o.log });
    o.log(`transcript klaar: ${segments.length} segmenten in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    if (!(e instanceof GeenSpraakError)) throw e;
    // Geen spraak (b-roll, muziek): de video komt er wél in, zodat hij niet
    // elke run opnieuw gedownload wordt, maar zonder transcript en zonder plan.
    geenSpraak = true;
    segments = null;
  }

  const energie = segments ? await mijnEnergie(analyse, segments).catch(() => []) : null;

  const { data: rij, error } = await supabase
    .from('videos')
    .insert({
      campaign_id: o.campaignId,
      title: o.titel,
      source_url: o.bronUrl,
      duration_seconds: Math.round(meting.duur),
      transcript: segments,
      transcript_raw: segments ? JSON.stringify(segments) : null,
      transcript_source: segments ? 'whisper' : null,
      energie_momenten: energie,
      breedte: meting.breedte,
      hoogte: meting.hoogte,
      auto_toegevoegd: true,
    })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') throw new Error('staat al in deze campagne');
    throw new Error(error.message);
  }
  const videoId = rij.id as string;

  await bewaarDirecteBron(videoId, analyse, o.pad, meting, o.log);

  if (geenSpraak) throw new GeenSpraakError();

  if (o.autoPlan) {
    await supabase.from('ai_jobs').insert({ soort: 'clip_plan', doel_id: videoId, parameters: {} });
  }
  return videoId;
}

/**
 * Zet de bron van een directe video in R2: altijd de analysekopie, en het
 * origineel als renderbron wanneer dat scherper is dan 1080p. Gemarkeerd als
 * blijvend: de opruimronde laat hem staan.
 */
export async function bewaarDirecteBron(
  videoId: string,
  analyse: string,
  origineel: string,
  meting: VideoMeting,
  log: (m: string) => void = () => {},
): Promise<void> {
  const analyseOk = await bewaarInBronCache(cacheSleutel(videoId, 'analyse.mp4'), analyse);
  let renderOk = true;
  if (heeftRenderKwaliteit(meting) && existsSync(origineel)) {
    renderOk = await bewaarInBronCache(cacheSleutel(videoId, `render${extname(origineel).toLowerCase() || '.mp4'}`), origineel);
    if (!renderOk) log(`origineel (${await mb(origineel)} MB) niet in R2 gezet — de render gebruikt de 1080p-kopie`);
  }
  if (analyseOk) {
    await markeerBlijvend(videoId);
    log(`bron in R2 gezet (analyse ${await mb(analyse)} MB${heeftRenderKwaliteit(meting) && renderOk ? `, origineel ${await mb(origineel)} MB als renderbron` : ''})`);
  } else {
    log('LET OP: bron niet in R2 gezet (geen R2 of upload mislukt) — de render-worker downloadt hem opnieuw van de bron');
  }
}

/** Het origineel als renderbron uit R2 halen (render.<ext>), of null als die er niet is. */
export async function haalDirecteRenderbron(videoId: string, map: string): Promise<string | null> {
  const kandidaten = (await lijstBronCache(cacheSleutel(videoId, 'render'))).map((o) => o.sleutel);
  const sleutel = kandidaten[0];
  if (!sleutel) return null;
  const doel = join(map, sleutel.split('/').pop()!);
  if (existsSync(doel)) return doel;
  return (await haalUitBronCache(sleutel, doel)) ? doel : null;
}
