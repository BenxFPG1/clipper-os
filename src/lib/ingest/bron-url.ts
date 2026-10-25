/**
 * Welke soort bron is deze link? Puur en zonder netwerk, zodat dezelfde
 * herkenning in de browser (directe validatie in het bronveld), in de API en
 * in de worker draait — en zonder internet te testen is (test-bronnen.ts).
 *
 * Campagnes leveren hun materiaal op vier manieren aan: een YouTube-video,
 * een YouTube-kanaal (of playlist), een Google Drive-bestand of -map, en een
 * WeTransfer. Alleen YouTube kan yt-dlp lezen; de andere twee halen we zelf op
 * (bronnen.ts). Elke video uit een map of transfer wordt een eigen videos-rij
 * met een eigen, stabiele bron-URL (bestandBronUrl) — daarop ontdubbelen we.
 */

export type Bron =
  | { soort: 'youtube_video'; videoId: string; url: string }
  | { soort: 'youtube_kanaal'; basis: string; tab: KanaalTab | null; handle: string | null }
  | { soort: 'youtube_playlist'; url: string }
  | { soort: 'drive_bestand'; id: string; mapId: string | null }
  | { soort: 'drive_map'; id: string }
  | {
      soort: 'wetransfer';
      transferId: string;
      hash: string;
      /** Eén bestand uit de transfer (zonder: de hele transfer). */
      bestandId: string | null;
      /** De korte we.tl-code waarmee hij is opgegeven (voor de status per bron). */
      via: string | null;
      /** Pad binnen een zip in de transfer: elke video uit een zip is een eigen bron. */
      pad: string | null;
    }
  | { soort: 'wetransfer_kort'; url: string; code: string }
  | { soort: 'onbekend'; reden: string };

export type KanaalTab = 'videos' | 'streams' | 'shorts' | 'live' | 'featured';

/** Drive-ids zijn 25+ tekens uit [A-Za-z0-9_-]; korter is bijna altijd een tikfout. */
const DRIVE_ID = /^[\w-]{20,}$/;

export function herkenBron(invoer: string): Bron {
  const tekst = (invoer ?? '').trim();
  if (!tekst) return { soort: 'onbekend', reden: 'Lege link.' };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(tekst) ? tekst : `https://${tekst}`);
  } catch {
    return { soort: 'onbekend', reden: 'Dit is geen geldige link.' };
  }
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  const delen = url.pathname.split('/').filter(Boolean);

  // ------------------------------------------------------------- YouTube
  if (host === 'youtu.be') {
    const id = delen[0];
    if (id && /^[\w-]{11}$/.test(id)) return { soort: 'youtube_video', videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
    return { soort: 'onbekend', reden: 'Deze youtu.be-link bevat geen video-id.' };
  }
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const v = url.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return { soort: 'youtube_video', videoId: v, url: `https://www.youtube.com/watch?v=${v}` };
    if (['shorts', 'live', 'embed'].includes(delen[0] ?? '') && /^[\w-]{11}$/.test(delen[1] ?? '')) {
      return { soort: 'youtube_video', videoId: delen[1], url: `https://www.youtube.com/watch?v=${delen[1]}` };
    }
    const lijst = url.searchParams.get('list');
    if (lijst) return { soort: 'youtube_playlist', url: `https://www.youtube.com/playlist?list=${lijst}` };

    // Kanaal: /@handle, /channel/UC…, /c/naam, /user/naam — met of zonder tab.
    let basisDelen: string[] | null = null;
    let handle: string | null = null;
    if (delen[0]?.startsWith('@') && delen[0].length > 1) {
      basisDelen = [delen[0]];
      handle = decodeURIComponent(delen[0]);
    } else if (delen[0] === 'channel' && /^UC[\w-]{10,}$/.test(delen[1] ?? '')) {
      basisDelen = delen.slice(0, 2);
    } else if ((delen[0] === 'c' || delen[0] === 'user') && delen[1]) {
      basisDelen = delen.slice(0, 2);
    }
    if (basisDelen) {
      const rest = delen[basisDelen.length]?.toLowerCase() ?? null;
      const tab = rest && ['videos', 'streams', 'shorts', 'live', 'featured'].includes(rest) ? (rest as KanaalTab) : null;
      return { soort: 'youtube_kanaal', basis: `https://www.youtube.com/${basisDelen.join('/')}`, tab, handle };
    }
    return { soort: 'onbekend', reden: 'YouTube-link herkend, maar geen video, kanaal of playlist.' };
  }

  // -------------------------------------------------------- Google Drive
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    // …/folders/<id>, ook /drive/u/1/folders/<id> en /drive/mobile/folders/<id>
    const mapIndex = delen.indexOf('folders');
    if (mapIndex !== -1) {
      const id = delen[mapIndex + 1];
      if (id && DRIVE_ID.test(id)) return { soort: 'drive_map', id };
      return { soort: 'onbekend', reden: 'Drive-maplink zonder geldig map-id.' };
    }
    // …/file/d/<id>/view, ook /file/u/0/d/<id>
    const dIndex = delen.indexOf('d');
    if (delen.includes('file') && dIndex !== -1) {
      const id = delen[dIndex + 1];
      if (id && DRIVE_ID.test(id)) return { soort: 'drive_bestand', id, mapId: schoonId(url.searchParams.get('map')) };
      return { soort: 'onbekend', reden: 'Drive-bestandslink zonder geldig bestands-id.' };
    }
    // open?id=… en uc?id=…&export=download
    const id = url.searchParams.get('id');
    if (id && DRIVE_ID.test(id)) return { soort: 'drive_bestand', id, mapId: null };
    if (host === 'docs.google.com') {
      return { soort: 'onbekend', reden: 'Een Google Docs/Sheets/Slides-document is geen video. Deel de video of de map met video\'s.' };
    }
    return { soort: 'onbekend', reden: 'Drive-link herkend, maar niet als bestand of map.' };
  }

  // ----------------------------------------------------------- WeTransfer
  if (host === 'we.tl') {
    const code = delen[0];
    if (code) return { soort: 'wetransfer_kort', url: `https://we.tl/${code}`, code };
    return { soort: 'onbekend', reden: 'Korte WeTransfer-link zonder code.' };
  }
  if (host === 'wetransfer.com' || host.endsWith('.wetransfer.com')) {
    if (host.startsWith('collect.')) {
      return { soort: 'onbekend', reden: 'Een WeTransfer-board (collect) wordt niet ondersteund; stuur een gewone transferlink.' };
    }
    // /downloads/<id>/<hash>, /downloads/<id>/<ontvanger>/<hash>, /previews/<id>/<hash>
    if ((delen[0] === 'downloads' || delen[0] === 'previews') && delen.length >= 3) {
      const transferId = delen[1];
      const hash = delen[delen.length - 1];
      if (/^[a-f0-9]{20,}$/i.test(transferId) && /^[a-f0-9]{4,}$/i.test(hash)) {
        return {
          soort: 'wetransfer',
          transferId,
          hash,
          bestandId: url.searchParams.get('bestand'),
          via: url.searchParams.get('via'),
          pad: url.searchParams.get('pad'),
        };
      }
    }
    return { soort: 'onbekend', reden: 'WeTransfer-link herkend, maar zonder transfer-id en code. Kopieer de downloadlink uit de mail.' };
  }

  if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
    return { soort: 'onbekend', reden: 'Dropbox wordt (nog) niet ondersteund. Gebruik Drive, WeTransfer of YouTube.' };
  }
  return { soort: 'onbekend', reden: 'Onbekende bron. Gebruik een YouTube-video/kanaal, Google Drive-bestand/map of WeTransfer-link.' };
}

function schoonId(id: string | null): string | null {
  return id && DRIVE_ID.test(id) ? id : null;
}

/** Bronnen die we zelf downloaden (geen yt-dlp, geen captions, geen 4K-secties). */
export function isDirecteBron(sourceUrl: string | null | undefined): boolean {
  if (!sourceUrl) return false;
  const b = herkenBron(sourceUrl);
  return b.soort === 'drive_bestand' || b.soort === 'wetransfer';
}

/** Kan deze bron meer dan één video opleveren (map, transfer, kanaal, playlist)? */
export function isVerzamelBron(b: Bron): boolean {
  return (
    b.soort === 'drive_map' ||
    b.soort === 'youtube_kanaal' ||
    b.soort === 'youtube_playlist' ||
    b.soort === 'wetransfer_kort' ||
    (b.soort === 'wetransfer' && !b.bestandId)
  );
}

/** Vaste bron-URL van één Drive-bestand; de map gaat mee zodat de UI weet waar hij vandaan komt. */
export function driveBestandUrl(id: string, mapId?: string | null): string {
  return `https://drive.google.com/file/d/${id}/view${mapId ? `?map=${mapId}` : ''}`;
}

/** Vaste bron-URL van één bestand uit een WeTransfer. */
export function wetransferBestandUrl(
  transferId: string,
  hash: string,
  bestandId: string,
  via?: string | null,
  pad?: string | null,
): string {
  const q = new URLSearchParams({ bestand: bestandId });
  if (via) q.set('via', via);
  if (pad) q.set('pad', pad);
  return `https://wetransfer.com/downloads/${transferId}/${hash}?${q.toString()}`;
}

/**
 * Sleutel waarop we ontdubbelen: twee schrijfwijzen van dezelfde video
 * (youtu.be vs watch?v=, Drive met of zonder ?usp=sharing) zijn dezelfde bron.
 */
export function bronSleutel(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  const b = herkenBron(sourceUrl);
  if (b.soort === 'youtube_video') return `yt:${b.videoId}`;
  if (b.soort === 'drive_bestand') return `drive:${b.id}`;
  if (b.soort === 'wetransfer' && b.bestandId) return `wt:${b.transferId}:${b.bestandId}${b.pad ? `:${b.pad}` : ''}`;
  return sourceUrl.trim();
}

/**
 * Komt deze video (bron-URL) uit deze opgegeven bron? Voor de status per bron
 * in de campagne-UI: "3 video's opgehaald" naast de Drive-map.
 */
export function hoortBijBron(bronInvoer: string, videoSourceUrl: string | null | undefined): boolean {
  if (!videoSourceUrl) return false;
  const bron = herkenBron(bronInvoer);
  const video = herkenBron(videoSourceUrl);
  switch (bron.soort) {
    case 'youtube_video':
      return video.soort === 'youtube_video' && video.videoId === bron.videoId;
    case 'drive_bestand':
      return video.soort === 'drive_bestand' && video.id === bron.id;
    case 'drive_map':
      return video.soort === 'drive_bestand' && video.mapId === bron.id;
    case 'wetransfer':
      return video.soort === 'wetransfer' && video.transferId === bron.transferId && (!bron.bestandId || bron.bestandId === video.bestandId);
    case 'wetransfer_kort':
      return video.soort === 'wetransfer' && video.via === bron.code;
    default:
      return false;
  }
}

/**
 * De tabs van een kanaal, in de volgorde waarin we ze proberen. Niet elk
 * kanaal heeft dezelfde tabs (alleen streams, alleen shorts); een opgegeven
 * tab gaat voor, de andere zijn het vangnet.
 */
export function kanaalKandidaten(b: Extract<Bron, { soort: 'youtube_kanaal' }>): string[] {
  const volgorde: KanaalTab[] = ['videos', 'streams', 'shorts'];
  const eerst: KanaalTab[] = b.tab && volgorde.includes(b.tab) ? [b.tab] : [];
  const tabs = [...eerst, ...volgorde.filter((t) => !eerst.includes(t))];
  return tabs.map((t) => `${b.basis}/${t}`);
}

/** Korte, menselijke omschrijving voor de UI ("Drive-map", "YouTube-kanaal @x"). */
export function beschrijfBron(b: Bron): string {
  switch (b.soort) {
    case 'youtube_video':
      return 'YouTube-video';
    case 'youtube_kanaal':
      return b.handle ? `YouTube-kanaal ${b.handle}` : 'YouTube-kanaal';
    case 'youtube_playlist':
      return 'YouTube-playlist';
    case 'drive_bestand':
      return 'Drive-bestand';
    case 'drive_map':
      return 'Drive-map';
    case 'wetransfer':
    case 'wetransfer_kort':
      return 'WeTransfer';
    default:
      return 'onbekend';
  }
}

/** Herkent een bestandsnaam als video (Drive-map, WeTransfer-zip). */
export function isVideoBestand(naam: string): boolean {
  return /\.(mp4|mov|m4v|webm|mkv|avi|mts|m2ts|mxf|wmv|mpg|mpeg|flv|3gp)$/i.test(naam.trim());
}

/** Titel uit een bestandsnaam: zonder map, zonder extensie. */
export function titelUitBestandsnaam(naam: string): string {
  const basis = naam.split(/[\\/]/).pop() ?? naam;
  return basis.replace(/\.[a-z0-9]{2,4}$/i, '').trim() || 'Naamloze video';
}
