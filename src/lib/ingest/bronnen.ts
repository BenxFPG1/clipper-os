import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveBinary } from './binaries';
import {
  type Bron,
  driveBestandUrl,
  herkenBron,
  isVideoBestand,
  titelUitBestandsnaam,
  wetransferBestandUrl,
} from './bron-url';

/**
 * Bronnen ophalen die yt-dlp niet kan lezen: Google Drive (bestand of map)
 * en WeTransfer. Gratis en zonder sleutels:
 *
 * - Drive via gdown (Python, staat in de workflows). Dat kan publieke
 *   "iedereen met de link"-bestanden en -mappen ophalen, ook boven de
 *   virusscan-grens (confirm-token), recursief en met bestandsnamen. Grote
 *   bestanden gaan rechtstreeks naar schijf.
 * - WeTransfer via dezelfde publieke API als de webapp zelf (zoals
 *   open-source tools als transferwee): prepare-download voor de lijst,
 *   download voor een tijdelijke directe link. Per bestand als dat kan; anders
 *   de hele transfer, en een zip pakken we uit.
 *
 * Wat hier misgaat krijgt een fout in gewone taal (BronFout): die belandt in
 * laatste_kanaal_fouten en op het dashboard, en moet zonder logs te
 * begrijpen zijn ("zet delen op 'iedereen met de link'").
 */

export type BronFoutSoort = 'niet_openbaar' | 'verlopen' | 'niet_gevonden' | 'wachtwoord' | 'geen_video' | 'tijdelijk' | 'gereedschap';

export class BronFout extends Error {
  constructor(
    message: string,
    readonly soort: BronFoutSoort,
  ) {
    super(message);
    this.name = 'BronFout';
  }
}

/** Eén video uit een map of transfer, met de vaste bron-URL waarop we ontdubbelen. */
export type BronBestand = { bronUrl: string; naam: string; titel: string; bytes: number | null };

export const DRIVE_NIET_OPENBAAR =
  "Drive-map is niet openbaar gedeeld — zet delen op 'iedereen met de link'";
const DRIVE_BESTAND_NIET_OPENBAAR =
  "Drive-bestand is niet openbaar gedeeld — zet delen op 'iedereen met de link'";

// ------------------------------------------------------------------ Drive

/** gdown in Python: lijst (zonder downloaden), info van één bestand, of downloaden. */
const GDOWN_SCRIPT = `
import json, sys
try:
    import gdown
except ImportError:
    sys.stderr.write("gdown ontbreekt. Installeer met: pip3 install gdown")
    sys.exit(3)
actie = sys.argv[1]
try:
    if actie == "map":
        r = gdown.download_folder(id=sys.argv[2], skip_download=True, quiet=True)
        print(json.dumps([{"id": f.id, "pad": f.path} for f in (r or [])]))
    elif actie == "info":
        r = gdown.download(id=sys.argv[2], skip_download=True, quiet=True)
        print(json.dumps({"id": r.id, "pad": r.path}))
    elif actie == "download":
        pad = gdown.download(id=sys.argv[2], output=sys.argv[3], quiet=False)
        if not pad:
            raise RuntimeError("gdown gaf geen bestand terug")
        print(json.dumps({"pad": pad}))
except Exception as e:
    sys.stderr.write(type(e).__name__ + ": " + str(e))
    sys.exit(2)
`;

let gdownPython: string | null = null;
/** De python waarin gdown staat (PYTHON_BIN, anders python3). Eén keer per proces gezocht. */
function pythonMetGdown(): string {
  if (gdownPython) return gdownPython;
  for (const bin of [process.env.PYTHON_BIN, 'python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'].filter(Boolean) as string[]) {
    const proef = spawnSync(bin, ['-c', 'import gdown'], { stdio: 'ignore' });
    if (proef.status === 0) return (gdownPython = bin);
  }
  throw new BronFout('gdown is niet geïnstalleerd (nodig om Drive op te halen). Installeer met: pip3 install gdown', 'gereedschap');
}

/** Herkent gdown's meldingen voor een niet-openbare of onbekende map/bestand. */
export function isNietOpenbaarMelding(melding: string): boolean {
  return /Anyone with the link|permission|Cannot retrieve the public link|Failed to retrieve (folder|file)|status code 40[134]|FileURLRetrievalError|access denied|have had many accesses/i.test(
    melding,
  );
}

async function gdown(args: string[], log?: (m: string) => void, timeoutMs = 20 * 60_000): Promise<unknown> {
  const uit = await runMetVoortgang(pythonMetGdown(), ['-c', GDOWN_SCRIPT, ...args], { log, timeoutMs });
  const regel = uit.trim().split('\n').pop() ?? '';
  return JSON.parse(regel);
}

export async function lijstDriveMap(mapId: string): Promise<BronBestand[]> {
  let rijen: { id: string; pad: string }[];
  try {
    rijen = (await gdown(['map', mapId], undefined, 5 * 60_000)) as { id: string; pad: string }[];
  } catch (e) {
    const m = (e as Error).message;
    if (e instanceof BronFout) throw e;
    // gdown noemt bij een privémap ook "many accesses" (Drive's eigen rem)
    // als mogelijke oorzaak; van buiten is dat niet te onderscheiden, en een
    // privémap is veruit het vaakst de reden.
    if (isNietOpenbaarMelding(m)) throw new BronFout(DRIVE_NIET_OPENBAAR, 'niet_openbaar');
    throw new BronFout(`Drive-map uitlezen mislukt: ${m.slice(-200)}`, 'tijdelijk');
  }
  const videos = rijen.filter((r) => isVideoBestand(r.pad));
  if (rijen.length > 0 && videos.length === 0) {
    throw new BronFout(`Drive-map bevat ${rijen.length} bestand(en), maar geen video's.`, 'geen_video');
  }
  if (rijen.length === 0) throw new BronFout(`Drive-map is leeg — of ${DRIVE_NIET_OPENBAAR.charAt(0).toLowerCase()}${DRIVE_NIET_OPENBAAR.slice(1)}`, 'niet_openbaar');
  return videos.map((r) => ({
    bronUrl: driveBestandUrl(r.id, mapId),
    // Submappen tellen mee in de naam: "Dag 1 - Clip 2.mov" is uniek, "Clip 2" niet.
    naam: r.pad,
    titel: titelUitBestandsnaam(r.pad.replace(/\//g, ' - ')),
    bytes: null,
  }));
}

export async function driveBestandInfo(id: string, mapId: string | null = null): Promise<BronBestand> {
  try {
    const r = (await gdown(['info', id], undefined, 2 * 60_000)) as { id: string; pad: string };
    return { bronUrl: driveBestandUrl(id, mapId), naam: r.pad, titel: titelUitBestandsnaam(r.pad), bytes: null };
  } catch (e) {
    if (e instanceof BronFout) throw e;
    const m = (e as Error).message;
    if (isNietOpenbaarMelding(m)) throw new BronFout(DRIVE_BESTAND_NIET_OPENBAAR, 'niet_openbaar');
    throw new BronFout(`Drive-bestand uitlezen mislukt: ${m.slice(-200)}`, 'tijdelijk');
  }
}

/** Downloadt één Drive-bestand naar `map` (gestreamd door gdown). Geeft het pad terug. */
export async function downloadDriveBestand(id: string, map: string, log: (m: string) => void = () => {}): Promise<string> {
  await mkdir(map, { recursive: true });
  // Met een slash aan het eind kiest gdown zelf de bestandsnaam van Drive.
  try {
    const r = (await gdown(['download', id, `${map}/`], log, 90 * 60_000)) as { pad: string };
    return r.pad;
  } catch (e) {
    if (e instanceof BronFout) throw e;
    const m = (e as Error).message;
    if (isNietOpenbaarMelding(m)) throw new BronFout(DRIVE_BESTAND_NIET_OPENBAAR, 'niet_openbaar');
    throw new BronFout(`Drive-download mislukt: ${m.slice(-200)}`, 'tijdelijk');
  }
}

// ------------------------------------------------------------- WeTransfer

const WT_HEADERS = {
  'Content-Type': 'application/json',
  'x-requested-with': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};

type WeTransferInfo = {
  state?: string;
  expires_at?: string;
  password_protected?: boolean;
  recommended_filename?: string;
  items?: { id: string; name: string; size?: number; item_type?: string }[];
  files?: { id: string; name: string; size?: number; item_type?: string }[];
};

/** we.tl/t-… volgt een redirect naar wetransfer.com/downloads/<id>/<hash>. */
export async function volgKorteLink(url: string): Promise<Extract<Bron, { soort: 'wetransfer' }>> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': WT_HEADERS['User-Agent'] }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new BronFout(`Korte WeTransfer-link niet te volgen: ${(e as Error).message}`, 'tijdelijk');
  }
  const doel = herkenBron(res.url);
  if (doel.soort !== 'wetransfer') {
    throw new BronFout('Korte WeTransfer-link leidt niet (meer) naar een transfer — waarschijnlijk verlopen of verwijderd.', 'verlopen');
  }
  return doel;
}

export async function wetransferInfo(transferId: string, hash: string): Promise<WeTransferInfo> {
  const res = await fetch(`https://wetransfer.com/api/v4/transfers/${transferId}/prepare-download`, {
    method: 'POST',
    headers: WT_HEADERS,
    body: JSON.stringify({ security_hash: hash }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e: Error) => {
    throw new BronFout(`WeTransfer niet bereikbaar: ${e.message}`, 'tijdelijk');
  });
  if (res.status === 404 || res.status === 410) {
    throw new BronFout('WeTransfer bestaat niet meer — verlopen of verwijderd. Vraag de campagne om een nieuwe link.', 'verlopen');
  }
  if (!res.ok) throw new BronFout(`WeTransfer gaf ${res.status} bij het uitlezen van de transfer.`, 'tijdelijk');
  const info = (await res.json()) as WeTransferInfo;
  controleerTransferStaat(info);
  return info;
}

/** Verlopen, verwijderd of met wachtwoord: een duidelijke fout in plaats van een lege download. */
export function controleerTransferStaat(info: WeTransferInfo): void {
  if (info.password_protected) {
    throw new BronFout('WeTransfer is beveiligd met een wachtwoord — vraag een link zonder wachtwoord.', 'wachtwoord');
  }
  if (info.state && info.state !== 'downloadable') {
    const sinds = info.expires_at ? ` (verliep ${info.expires_at.slice(0, 10)})` : '';
    throw new BronFout(`WeTransfer is verlopen of verwijderd${sinds} — vraag de campagne om een nieuwe link.`, 'verlopen');
  }
}

export async function lijstWeTransfer(b: Extract<Bron, { soort: 'wetransfer' }>, via: string | null = b.via): Promise<BronBestand[]> {
  const info = await wetransferInfo(b.transferId, b.hash);
  const items = (info.items ?? info.files ?? []).filter((i) => !i.item_type || i.item_type === 'file');
  const videos = items.filter((i) => isVideoBestand(i.name) || /\.zip$/i.test(i.name));
  if (items.length > 0 && videos.length === 0) {
    throw new BronFout(`WeTransfer bevat ${items.length} bestand(en), maar geen video's.`, 'geen_video');
  }
  const gekozen = b.bestandId ? videos.filter((v) => v.id === b.bestandId) : videos;
  return gekozen.map((i) => ({
    bronUrl: wetransferBestandUrl(b.transferId, b.hash, i.id, via),
    naam: i.name,
    titel: titelUitBestandsnaam(i.name),
    bytes: i.size ?? null,
  }));
}

async function wetransferDirecteLink(transferId: string, hash: string, bestandId: string | null): Promise<string> {
  const body = bestandId
    ? { security_hash: hash, intent: 'single_file', file_ids: [bestandId] }
    : { security_hash: hash, intent: 'entire_transfer' };
  const res = await fetch(`https://wetransfer.com/api/v4/transfers/${transferId}/download`, {
    method: 'POST',
    headers: WT_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404 || res.status === 410) {
    throw new BronFout('WeTransfer bestaat niet meer — verlopen of verwijderd. Vraag de campagne om een nieuwe link.', 'verlopen');
  }
  const json = (await res.json().catch(() => ({}))) as { direct_link?: string; message?: string };
  if (!res.ok || !json.direct_link) {
    throw new BronFout(`WeTransfer gaf geen downloadlink (${res.status}${json.message ? `: ${json.message}` : ''}).`, 'tijdelijk');
  }
  return json.direct_link;
}

/**
 * Downloadt één bestand uit een transfer (of, zonder bestandId, de hele
 * transfer). Lukt de download per bestand niet, dan de hele transfer. Een zip
 * pakken we uit; terug komen alle video's die erin zaten.
 */
export async function downloadWeTransferBestanden(
  b: Extract<Bron, { soort: 'wetransfer' }>,
  map: string,
  log: (m: string) => void = () => {},
): Promise<string[]> {
  await mkdir(map, { recursive: true });
  const info = await wetransferInfo(b.transferId, b.hash);
  const items = info.items ?? info.files ?? [];
  const item = b.bestandId ? items.find((i) => i.id === b.bestandId) : null;
  if (b.bestandId && !item) throw new BronFout('Dit bestand staat niet (meer) in de WeTransfer.', 'niet_gevonden');

  let link: string;
  let naam: string;
  let heleTransfer = !item;
  try {
    link = await wetransferDirecteLink(b.transferId, b.hash, item?.id ?? null);
    naam = item?.name ?? info.recommended_filename ?? 'transfer.zip';
  } catch (e) {
    if (!item || (e instanceof BronFout && e.soort === 'verlopen')) throw e;
    log(`per bestand downloaden lukte niet (${(e as Error).message.slice(0, 80)}); de hele transfer`);
    link = await wetransferDirecteLink(b.transferId, b.hash, null);
    naam = info.recommended_filename ?? 'transfer.zip';
    heleTransfer = true;
  }

  const pad = join(map, veiligeNaam(naam));
  log(`WeTransfer downloaden: ${naam}${item?.size ? ` (${Math.round(item.size / 1e6)} MB)` : ''}`);
  await streamNaarBestand(link, pad, log);

  if (!/\.zip$/i.test(pad)) return [pad];
  const videos = (await pakZipUit(pad, join(map, 'zip'))).filter((p) => isVideoBestand(p));
  if (videos.length === 0) throw new BronFout('De WeTransfer-zip bevat geen video.', 'geen_video');
  // Viel het terug op de hele transfer, dan alleen het gevraagde bestand.
  if (heleTransfer && item) {
    const passend = videos.find((p) => p.endsWith(`/${item.name}`));
    if (passend) return [passend];
  }
  return videos;
}

/** De video achter één wetransfer-bron: met `pad` het bestand uit de zip, anders het eerste. */
export async function downloadWeTransferBestand(
  b: Extract<Bron, { soort: 'wetransfer' }>,
  map: string,
  log: (m: string) => void = () => {},
): Promise<string> {
  const videos = await downloadWeTransferBestanden(b, map, log);
  if (b.pad) {
    const passend = videos.find((p) => p.endsWith(`/${b.pad}`));
    if (!passend) throw new BronFout(`"${b.pad}" staat niet (meer) in de WeTransfer-zip.`, 'niet_gevonden');
    return passend;
  }
  return videos[0];
}

/** Alle video's uit een WeTransfer-zip (voor transfers die alleen als zip te halen zijn). */
export async function pakZipUit(zip: string, doel: string): Promise<string[]> {
  await mkdir(doel, { recursive: true });
  await runMetVoortgang('unzip', ['-o', '-q', zip, '-d', doel], { timeoutMs: 30 * 60_000 });
  await rm(zip, { force: true });
  const uit: string[] = [];
  for (const item of await readdir(doel, { withFileTypes: true, recursive: true })) {
    if (!item.isFile() || item.name.startsWith('._')) continue; // macOS-resten in zips
    uit.push(join(item.parentPath ?? (item as { path?: string }).path ?? doel, item.name));
  }
  return uit.sort();
}

// ------------------------------------------------------------ gezamenlijk

/**
 * Alle video's achter een opgegeven bron (Drive-map/-bestand of WeTransfer),
 * zonder iets te downloaden: de lijst waarop we ontdubbelen.
 */
export async function lijstBronBestanden(invoer: string): Promise<BronBestand[]> {
  const b = herkenBron(invoer);
  switch (b.soort) {
    case 'drive_map':
      return lijstDriveMap(b.id);
    case 'drive_bestand': {
      const info = await driveBestandInfo(b.id, b.mapId);
      if (!isVideoBestand(info.naam)) throw new BronFout(`Drive-bestand "${info.naam}" is geen video.`, 'geen_video');
      return [info];
    }
    case 'wetransfer':
      return lijstWeTransfer(b);
    case 'wetransfer_kort':
      return lijstWeTransfer(await volgKorteLink(b.url), b.code);
    default:
      throw new BronFout(`Geen Drive- of WeTransfer-bron: ${invoer}`, 'niet_gevonden');
  }
}

/** Downloadt de video achter één vaste bron-URL (uit lijstBronBestanden) naar `map`. */
export async function downloadBronBestand(bronUrl: string, map: string, log: (m: string) => void = () => {}): Promise<string> {
  const b = herkenBron(bronUrl);
  if (b.soort === 'drive_bestand') return downloadDriveBestand(b.id, map, log);
  if (b.soort === 'wetransfer') return downloadWeTransferBestand(b, map, log);
  throw new BronFout(`Geen downloadbare bron: ${bronUrl}`, 'niet_gevonden');
}

/** Een directe link gestreamd naar schijf (via een .deel-bestand), met voortgang per ~10%. */
export async function streamNaarBestand(url: string, pad: string, log: (m: string) => void = () => {}): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2 * 60 * 60_000) });
  if (!res.ok || !res.body) throw new BronFout(`Download mislukt (${res.status}).`, 'tijdelijk');
  const totaal = Number(res.headers.get('content-length') ?? 0);
  let binnen = 0;
  let volgendeMelding = 0.1;
  const t0 = Date.now();
  const bron = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  bron.on('data', (d: Buffer) => {
    binnen += d.length;
    if (totaal > 0 && binnen / totaal >= volgendeMelding) {
      log(`download ${Math.round((binnen / totaal) * 100)}% (${Math.round(binnen / 1e6)} van ${Math.round(totaal / 1e6)} MB, ${Math.round((Date.now() - t0) / 1000)}s)`);
      volgendeMelding += 0.1;
    }
  });
  const deel = `${pad}.deel`;
  await pipeline(bron, createWriteStream(deel));
  await rename(deel, pad);
  if (totaal === 0) log(`download klaar (${Math.round(binnen / 1e6)} MB)`);
}

function veiligeNaam(naam: string): string {
  const schoon = naam.replace(/[\\/:*?"<>|\0]+/g, '_').replace(/^\.+/, '').trim();
  return schoon || `bron${extname(naam) || '.mp4'}`;
}

// --------------------------------------------------------- analysekopie

export type VideoMeting = { breedte: number; hoogte: number; duur: number; codec: string; audioCodec: string | null; rotatie: number; pixFmt: string };

export async function meetVideo(pad: string): Promise<VideoMeting> {
  const uit = await runMetVoortgang(resolveBinary('ffprobe'), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', pad,
  ], { timeoutMs: 2 * 60_000 });
  const j = JSON.parse(uit) as {
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[];
    format?: { duration?: string };
  };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  if (!v) throw new BronFout('Het bestand bevat geen videospoor.', 'geen_video');
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  const rotatie = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0)) % 360;
  // Een gedraaide telefoonvideo staat rechtop op het scherm: breedte en hoogte wisselen.
  const [breedte, hoogte] = rotatie === 90 || rotatie === 270 ? [v.height ?? 0, v.width ?? 0] : [v.width ?? 0, v.height ?? 0];
  return {
    breedte,
    hoogte,
    duur: Number(j.format?.duration ?? 0),
    codec: v.codec_name ?? '',
    audioCodec: a?.codec_name ?? null,
    rotatie,
    pixFmt: v.pix_fmt ?? '',
  };
}

/** Korte zijde boven 1080? Dan is het origineel scherper dan de analysekopie en dient het als renderbron. */
export const ANALYSE_KORTE_ZIJDE = 1080;
export function heeftRenderKwaliteit(m: Pick<VideoMeting, 'breedte' | 'hoogte'>): boolean {
  return Math.min(m.breedte, m.hoogte) > ANALYSE_KORTE_ZIJDE;
}

/**
 * De analysebron: H.264 + AAC in mp4, korte zijde hoogstens 1080 (OpenCV,
 * scènes, gezichten en Premiere lezen dat overal). Is het origineel dat al,
 * dan alleen omverpakken — seconden in plaats van minuten.
 */
export async function maakAnalyseKopie(origineel: string, doel: string, log: (m: string) => void = () => {}): Promise<VideoMeting> {
  const m = await meetVideo(origineel);
  const alGoed =
    m.codec === 'h264' &&
    m.pixFmt === 'yuv420p' &&
    m.rotatie === 0 &&
    !heeftRenderKwaliteit(m) &&
    (m.audioCodec === null || m.audioCodec === 'aac');
  const tijdelijk = `${doel}.deel.mp4`;
  const t0 = Date.now();
  if (alGoed) {
    await runMetVoortgang(resolveBinary('ffmpeg'), ['-y', '-v', 'error', '-i', origineel, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', tijdelijk], { timeoutMs: 30 * 60_000 });
  } else {
    log(`analysekopie maken (${m.breedte}x${m.hoogte} ${m.codec} → H.264, korte zijde ≤${ANALYSE_KORTE_ZIJDE}, ${Math.round(m.duur / 60)} min)…`);
    const k = ANALYSE_KORTE_ZIJDE;
    const schaal = `scale='if(gt(iw,ih),-2,min(${k},iw))':'if(gt(iw,ih),min(${k},ih),-2)'`;
    await runMetVoortgang(resolveBinary('ffmpeg'), [
      '-y', '-v', 'error', '-i', origineel,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `${schaal},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-movflags', '+faststart',
      tijdelijk,
    ], { timeoutMs: 90 * 60_000 });
  }
  await rename(tijdelijk, doel);
  log(`analysekopie klaar in ${Math.round((Date.now() - t0) / 1000)}s (${alGoed ? 'omverpakt' : 'hercodeerd'})`);
  return m;
}

// ------------------------------------------------------------------ proces

export function runMetVoortgang(
  cmd: string,
  args: string[],
  opties: { log?: (m: string) => void; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const kind = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    let laatsteLog = 0;
    const timer = setTimeout(() => {
      kind.kill('SIGKILL');
      reject(new Error(`${cmd} duurde langer dan ${Math.round((opties.timeoutMs ?? 0) / 60_000)} min`));
    }, opties.timeoutMs ?? 30 * 60_000);
    kind.stdout.on('data', (d) => (stdout += d));
    kind.stderr.on('data', (d: Buffer) => {
      const tekst = d.toString();
      stderr = (stderr + tekst).slice(-4000);
      // gdown/tqdm schrijft voortgang naar stderr; eens per halve minuut doorgeven.
      if (opties.log && Date.now() - laatsteLog > 30_000) {
        const regel = tekst.split(/[\r\n]+/).filter((r) => /\d+%/.test(r)).pop();
        if (regel) {
          opties.log(regel.trim().slice(0, 120));
          laatsteLog = Date.now();
        }
      }
    });
    kind.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new BronFout(`${cmd} is niet geïnstalleerd.`, 'gereedschap') : e);
    });
    kind.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else if (code === 3) reject(new BronFout(stderr.trim() || `${cmd}: module ontbreekt`, 'gereedschap'));
      else reject(new Error(`${cmd.split('/').pop()} exit ${code}: ${stderr.trim().slice(-600)}`));
    });
  });
}

/** Grootte van een bestand in MB (voor de log). */
export async function mb(pad: string): Promise<number> {
  return existsSync(pad) ? Math.round((await stat(pad)).size / 1e6) : 0;
}
