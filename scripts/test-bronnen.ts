/**
 * Test voor de bronherkenning (src/lib/ingest/bron-url.ts) en de pure
 * hulpfuncties rond Drive, WeTransfer en YouTube-kanalen. Zonder netwerk en
 * zonder database: alleen URL-herkenning, id/hash-parsing, kanaalvarianten,
 * ontdubbelsleutels en de foutherkenning.
 *
 * Draaien: npm run test:bronnen
 */
import {
  beschrijfBron,
  bronSleutel,
  driveBestandUrl,
  herkenBron,
  hoortBijBron,
  isDirecteBron,
  isVideoBestand,
  kanaalKandidaten,
  titelUitBestandsnaam,
  wetransferBestandUrl,
  type Bron,
} from '../src/lib/ingest/bron-url';
import { BronFout, controleerTransferStaat, heeftRenderKwaliteit, isNietOpenbaarMelding } from '../src/lib/ingest/bronnen';
import { isKanaal404, kanaal404Melding } from '../src/lib/ingest/kanaal';
import { inGewoneTaal } from '../src/lib/status';

let gefaald = 0;
let gedaan = 0;
function toets(naam: string, voorwaarde: boolean, detail = '') {
  gedaan++;
  if (voorwaarde) console.log(`  ✓ ${naam}`);
  else {
    gefaald++;
    console.log(`  ✗ ${naam}${detail ? ` — ${detail}` : ''}`);
  }
}
const toon = (b: Bron) => JSON.stringify(b);

const DRIVE_MAP = '1_i-jzs4IgZ_oqk_oYc0JLDQD4en6UxKJ';
const DRIVE_BESTAND = '1SO8bFvoV8ODCBqvDFucJ7WRKYxQXXqR4';
const WT_ID = '0470d7579efcbf2dde6ec3de90a4c75320261018161344';

console.log('YouTube-video');
for (const url of [
  'https://www.youtube.com/watch?v=DDrutjNnfKM',
  'https://youtube.com/watch?v=DDrutjNnfKM&t=42s',
  'https://m.youtube.com/watch?feature=share&v=DDrutjNnfKM',
  'https://youtu.be/DDrutjNnfKM?si=abc',
  'https://www.youtube.com/shorts/DDrutjNnfKM',
  'https://www.youtube.com/live/DDrutjNnfKM?feature=share',
  'youtube.com/watch?v=DDrutjNnfKM',
]) {
  const b = herkenBron(url);
  toets(`${url} → video DDrutjNnfKM`, b.soort === 'youtube_video' && b.videoId === 'DDrutjNnfKM', toon(b));
}
toets('watch?v=…&list=… blijft een video', herkenBron('https://www.youtube.com/watch?v=DDrutjNnfKM&list=PL123').soort === 'youtube_video');
toets('playlist', herkenBron('https://www.youtube.com/playlist?list=PLabc123').soort === 'youtube_playlist');

console.log('YouTube-kanaal');
const kanalen: [string, string, string | null][] = [
  ['https://www.youtube.com/@upfront', 'https://www.youtube.com/@upfront', null],
  ['https://www.youtube.com/@upfront/', 'https://www.youtube.com/@upfront', null],
  ['https://www.youtube.com/@upfront/videos', 'https://www.youtube.com/@upfront', 'videos'],
  ['https://www.youtube.com/@upfront/streams', 'https://www.youtube.com/@upfront', 'streams'],
  ['https://www.youtube.com/@upfront/shorts?app=desktop', 'https://www.youtube.com/@upfront', 'shorts'],
  ['https://m.youtube.com/@upfront/featured', 'https://www.youtube.com/@upfront', 'featured'],
  ['https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv', 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv', null],
  ['https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/streams', 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv', 'streams'],
  ['https://www.youtube.com/c/StukTV', 'https://www.youtube.com/c/StukTV', null],
  ['https://www.youtube.com/c/StukTV/videos', 'https://www.youtube.com/c/StukTV', 'videos'],
  ['https://www.youtube.com/user/StukTV', 'https://www.youtube.com/user/StukTV', null],
];
for (const [url, basis, tab] of kanalen) {
  const b = herkenBron(url);
  toets(`${url} → kanaal ${basis}${tab ? ` (${tab})` : ''}`, b.soort === 'youtube_kanaal' && b.basis === basis && b.tab === tab, toon(b));
}
{
  const b = herkenBron('https://www.youtube.com/@upfront') as Extract<Bron, { soort: 'youtube_kanaal' }>;
  toets('handle bewaard', b.handle === '@upfront');
  const k = kanaalKandidaten(b);
  toets('zonder tab: videos, streams, shorts', k.join() === ['videos', 'streams', 'shorts'].map((t) => `https://www.youtube.com/@upfront/${t}`).join(), k.join());
  const s = kanaalKandidaten(herkenBron('https://www.youtube.com/@upfront/streams') as Extract<Bron, { soort: 'youtube_kanaal' }>);
  toets('opgegeven tab eerst, de rest als vangnet', s[0].endsWith('/streams') && s.length === 3 && s.includes('https://www.youtube.com/@upfront/videos'), s.join());
  const f = kanaalKandidaten(herkenBron('https://www.youtube.com/@upfront/featured') as Extract<Bron, { soort: 'youtube_kanaal' }>);
  toets('featured-tab → gewone volgorde', f[0].endsWith('/videos'), f.join());
}
toets('404 herkend', isKanaal404('ERROR: [youtube:tab] @upfront/videos: Unable to download API page: HTTP Error 404: Not Found'));
toets('andere fout geen 404', !isKanaal404('ERROR: This channel does not have a streams tab'));
toets('404-melding noemt de handle', kanaal404Melding('@upfront').includes('@upfront') && kanaal404Melding('@upfront').includes('bestaat niet'));
toets('youtube.com zonder video/kanaal → onbekend', herkenBron('https://www.youtube.com/feed/trending').soort === 'onbekend');

console.log('Google Drive');
for (const url of [
  `https://drive.google.com/drive/u/1/folders/${DRIVE_MAP}`,
  `https://drive.google.com/drive/folders/${DRIVE_MAP}?usp=sharing`,
  `https://drive.google.com/drive/u/0/folders/${DRIVE_MAP}?usp=drive_link`,
  `https://drive.google.com/drive/mobile/folders/${DRIVE_MAP}`,
  `drive.google.com/drive/folders/${DRIVE_MAP}`,
]) {
  const b = herkenBron(url);
  toets(`${url} → map`, b.soort === 'drive_map' && b.id === DRIVE_MAP, toon(b));
}
for (const url of [
  `https://drive.google.com/file/d/${DRIVE_BESTAND}/view?usp=sharing`,
  `https://drive.google.com/file/d/${DRIVE_BESTAND}/view`,
  `https://drive.google.com/file/d/${DRIVE_BESTAND}`,
  `https://drive.google.com/file/u/1/d/${DRIVE_BESTAND}/view?usp=drive_link`,
  `https://drive.google.com/open?id=${DRIVE_BESTAND}`,
  `https://drive.google.com/uc?id=${DRIVE_BESTAND}&export=download`,
  `https://docs.google.com/file/d/${DRIVE_BESTAND}/edit`,
]) {
  const b = herkenBron(url);
  toets(`${url} → bestand`, b.soort === 'drive_bestand' && b.id === DRIVE_BESTAND, toon(b));
}
toets('Drive-map zonder id → onbekend', herkenBron('https://drive.google.com/drive/folders/').soort === 'onbekend');
toets('Google Docs-document → onbekend met uitleg', (() => {
  const b = herkenBron('https://docs.google.com/document/d/abc/edit');
  return b.soort === 'onbekend' && /geen video/.test(b.reden);
})());
{
  const url = driveBestandUrl(DRIVE_BESTAND, DRIVE_MAP);
  const b = herkenBron(url);
  toets('vaste bron-URL van een mapbestand terug te lezen', b.soort === 'drive_bestand' && b.id === DRIVE_BESTAND && b.mapId === DRIVE_MAP, url);
  toets('mapbestand hoort bij de map', hoortBijBron(`https://drive.google.com/drive/u/1/folders/${DRIVE_MAP}?usp=sharing`, url));
  toets('mapbestand hoort niet bij een andere map', !hoortBijBron('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz0', url));
  toets('ontdubbelen: met/zonder ?usp en map is hetzelfde bestand',
    bronSleutel(url) === bronSleutel(`https://drive.google.com/file/d/${DRIVE_BESTAND}/view?usp=sharing`));
  toets('Drive-bestand is een directe bron', isDirecteBron(url));
  toets('Drive-map zelf is geen directe bron (verzamelbron)', !isDirecteBron(`https://drive.google.com/drive/folders/${DRIVE_MAP}`));
}
toets('gdown: niet openbaar herkend', isNietOpenbaarMelding(
  "DownloadError Failed to retrieve folder contents for folder ID: x (status code 404). You may need to change the permission to 'Anyone with the link'",
));
toets('gdown: bestand niet openbaar herkend', isNietOpenbaarMelding('FileURLRetrievalError: Cannot retrieve the public link of the file.'));
toets('gdown: netwerkfout is iets anders', !isNietOpenbaarMelding('ConnectionError: Max retries exceeded'));

console.log('WeTransfer');
const wtVarianten: [string, string][] = [
  [`https://wetransfer.com/previews/${WT_ID}/b9d028`, 'b9d028'],
  [`https://wetransfer.com/downloads/${WT_ID}/b9d028`, 'b9d028'],
  [`https://wetransfer.com/downloads/${WT_ID}/b9d028?t_exp=1794932025&t_network=link`, 'b9d028'],
  [`https://wetransfer.com/downloads/${WT_ID}/0a1b2c3d4e5f60718293a4b5c6d7e8f920261018161344/b9d028`, 'b9d028'],
  [`https://bedrijf.wetransfer.com/downloads/${WT_ID}/b9d028`, 'b9d028'],
];
for (const [url, hash] of wtVarianten) {
  const b = herkenBron(url);
  toets(`${url.slice(0, 70)}… → transfer + hash`, b.soort === 'wetransfer' && b.transferId === WT_ID && b.hash === hash && !b.bestandId, toon(b));
}
{
  const b = herkenBron('https://we.tl/t-pEutYTGVJVadWrXk');
  toets('we.tl korte link', b.soort === 'wetransfer_kort' && b.code === 't-pEutYTGVJVadWrXk', toon(b));
  toets('collect.wetransfer.com → onbekend', herkenBron('https://collect.wetransfer.com/board/abc').soort === 'onbekend');
  toets('WeTransfer zonder hash → onbekend', herkenBron(`https://wetransfer.com/downloads/${WT_ID}`).soort === 'onbekend');
  const item = '6c3c2dfc62d04d09033b3f700672438620261018161404';
  const url = wetransferBestandUrl(WT_ID, 'b9d028', item, 't-pEutYTGVJVadWrXk');
  const p = herkenBron(url);
  toets('vaste bron-URL per bestand terug te lezen', p.soort === 'wetransfer' && p.bestandId === item && p.via === 't-pEutYTGVJVadWrXk' && p.pad === null, url);
  toets('bestand hoort bij de transfer', hoortBijBron(`https://wetransfer.com/previews/${WT_ID}/b9d028`, url));
  toets('bestand hoort bij de korte link', hoortBijBron('https://we.tl/t-pEutYTGVJVadWrXk', url));
  toets('bestand in transfer is een directe bron', isDirecteBron(url));
  const zip = wetransferBestandUrl(WT_ID, 'b9d028', item, null, 'map/Video 1.mov');
  const z = herkenBron(zip);
  toets('pad binnen een zip bewaard', z.soort === 'wetransfer' && z.pad === 'map/Video 1.mov', zip);
  toets('twee video\'s uit één zip zijn twee bronnen', bronSleutel(zip) !== bronSleutel(wetransferBestandUrl(WT_ID, 'b9d028', item, null, 'map/Video 2.mov')));
}
{
  let verlopen = '';
  try {
    controleerTransferStaat({ state: 'expired', expires_at: '2026-10-25T10:00:00Z' });
  } catch (e) {
    verlopen = e instanceof BronFout ? `${e.soort}: ${e.message}` : String(e);
  }
  toets('verlopen transfer → duidelijke fout', verlopen.startsWith('verlopen:') && verlopen.includes('2026-10-25'), verlopen);
  let wachtwoord = '';
  try {
    controleerTransferStaat({ state: 'downloadable', password_protected: true });
  } catch (e) {
    wachtwoord = (e as BronFout).soort;
  }
  toets('transfer met wachtwoord → fout', wachtwoord === 'wachtwoord');
  let ok = true;
  try {
    controleerTransferStaat({ state: 'downloadable' });
  } catch {
    ok = false;
  }
  toets('downloadbare transfer → geen fout', ok);
}

console.log('Overig');
toets('onzin → onbekend', herkenBron('geen link').soort === 'onbekend');
toets('dropbox → onbekend met reden', /Dropbox/.test((herkenBron('https://www.dropbox.com/s/abc/x.mp4') as { reden?: string }).reden ?? ''));
toets('lege invoer → onbekend', herkenBron('  ').soort === 'onbekend');
toets('YouTube is geen directe bron', !isDirecteBron('https://www.youtube.com/watch?v=DDrutjNnfKM'));
toets('youtu.be en watch?v= zelfde sleutel', bronSleutel('https://youtu.be/DDrutjNnfKM') === bronSleutel('https://www.youtube.com/watch?v=DDrutjNnfKM&t=1'));
toets('videobestanden herkend', ['a.mp4', 'B.MOV', 'c.mkv', 'd.mxf', 'e.MTS'].every(isVideoBestand) && !isVideoBestand('briefing.pdf') && !isVideoBestand('x.zip'));
toets('titel zonder extensie en map', titelUitBestandsnaam('Dag 1/Clip 2-1.mov') === 'Clip 2-1' && titelUitBestandsnaam('434.mp4') === '434');
toets('beschrijving', beschrijfBron(herkenBron(`https://drive.google.com/drive/folders/${DRIVE_MAP}`)) === 'Drive-map');
toets('4K is renderkwaliteit, 1080p niet', heeftRenderKwaliteit({ breedte: 3840, hoogte: 2160 }) && !heeftRenderKwaliteit({ breedte: 1920, hoogte: 1080 }));
toets('verticaal 1080x1920 is geen renderkwaliteit (korte zijde)', !heeftRenderKwaliteit({ breedte: 1080, hoogte: 1920 }));
toets('gewone taal: geen JSON', /niet als plan te lezen/.test(inGewoneTaal('Geen JSON in CLI-antwoord (character_map)')));
toets('gewone taal: Drive', inGewoneTaal("Drive-map is niet openbaar gedeeld — zet delen op 'iedereen met de link'").startsWith('Drive-map is niet openbaar'));
toets('gewone taal: 404', /YouTube-kanaal @upfront bestaat niet/.test(inGewoneTaal(kanaal404Melding('@upfront'))));

console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
if (gefaald > 0) process.exit(1);
