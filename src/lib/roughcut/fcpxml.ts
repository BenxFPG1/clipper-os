import { Shot } from './index';

export type Marker = {
  /** Positie op de tijdlijn in seconden. */
  start: number;
  /** Eindpunt; met een eind krijg je een gekleurd bereik in plaats van een punt. */
  end?: number;
  naam: string;
  notitie?: string;
};

export type Overlay = {
  /** Positie op de tijdlijn in seconden. */
  start: number;
  end: number;
  /** Absoluut pad naar de PNG met de tekstkaart. */
  pad: string;
  naam: string;
};

export type ClipVoorProject = {
  nummer: number;
  titel: string;
  shots: Shot[];
  /** Volledige naam in Premiere; zonder dit wordt "01 - titel" gebruikt. */
  label?: string;
  /** Eén doorlopend fragment i.p.v. losse shots (voor de overzichtssequence). */
  doorlopend?: { start: number; end: number };
  /** Markers op de tijdlijn: waar knippen, en wat er moet gebeuren. */
  markers?: Marker[];
  /** Tekstkaarten als beeldlaag boven de montage. */
  overlays?: Overlay[];
};

export type BronInfo = {
  /** Absoluut pad naar de bronvideo op schijf. */
  pad: string;
  fps: number;
  breedte: number;
  hoogte: number;
};

/**
 * Bouwt een Premiere Pro-project (FCP7 XML) met per clip een eigen sequence:
 * de shots uit het plan staan als losse cuts op de tijdlijn, met de originele
 * bronkwaliteit eronder.
 *
 * Dit is het antwoord op "de cuts moeten beter": in plaats van een gebakken
 * bestand waar de knippen vastliggen, krijgt de editor een tijdlijn waar elke
 * cut nog te verschuiven is en de uitlijning naar verticaal met de volle
 * bronresolutie gebeurt. Het formaat opent ook in DaVinci Resolve (gratis).
 * CapCut kent helaas geen open projectformaat; daarvoor blijft de mp4-route.
 */
export function bouwPremiereXml(projectNaam: string, bron: BronInfo, clips: ClipVoorProject[]): string {
  const tb = Math.round(bron.fps);
  const ntsc = Math.abs(bron.fps - tb) > 0.01 ? 'TRUE' : 'FALSE';
  const naarFrames = (seconden: number) => Math.round(seconden * bron.fps);

  // Bij een relatief pad (download via de site) laten we het pad kaal: Premiere
  // vindt het bestand dan naast de .xml, of vraagt eenmalig om te relinken.
  const pathurl = bron.pad.startsWith('/')
    ? `file://localhost${encodeURI(bron.pad).replace(/#/g, '%23')}`
    : encodeURI(bron.pad).replace(/#/g, '%23');

  let eersteFileRef = true;
  const fileNode = (indent: string): string => {
    if (!eersteFileRef) return `${indent}<file id="bron-1"/>`;
    eersteFileRef = false;
    return `${indent}<file id="bron-1">
${indent}  <name>${xml(basename(bron.pad))}</name>
${indent}  <pathurl>${xml(pathurl)}</pathurl>
${indent}  <rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>
${indent}  <media>
${indent}    <video><samplecharacteristics><rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate><width>${bron.breedte}</width><height>${bron.hoogte}</height></samplecharacteristics></video>
${indent}    <audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>
${indent}  </media>
${indent}</file>`;
  };

  const sequences = clips
    .map((clip, seqIndex) => {
      // Ids op basis van de plek in de lijst: twee varianten van dezelfde clip
      // hebben hetzelfde nummer, en dubbele ids weigert Premiere.
      const sid = seqIndex + 1;
      const shots = clip.doorlopend
        ? [{ volgorde: 1, start: clip.doorlopend.start, end: clip.doorlopend.end, functie: 'bron', edit_notitie: '' } as Shot]
        : [...clip.shots].sort((a, b) => a.volgorde - b.volgorde).filter((s) => s.end > s.start);
      let cursor = 0;
      const video: string[] = [];
      const audio: string[] = [];

      for (const [i, shot] of shots.entries()) {
        const duurFrames = naarFrames(shot.end - shot.start);
        const inF = naarFrames(shot.start);
        const outF = naarFrames(shot.end);
        const start = cursor;
        const eind = cursor + duurFrames;
        cursor = eind;

        const naam = xml(`${String(i + 1).padStart(2, '0')} ${shot.functie}${shot.edit_notitie ? ` — ${shot.edit_notitie.slice(0, 60)}` : ''}`);

        // Punch-in en snelle zoom zetten we meteen als Motion-schaal klaar.
        // Premiere leest dit als Effect Controls > Motion > Scale, dus je ziet
        // het effect direct en kunt het met één sleep bijstellen.
        const effect = (shot as { beeld_effect?: string }).beeld_effect;
        const zoom = effect === 'punch_in' ? 112 : effect === 'snelle_zoom' ? 118 : null;
        const motion = zoom
          ? `            <filter>
              <effect>
                <name>Basic Motion</name>
                <effectid>basic</effectid>
                <effectcategory>motion</effectcategory>
                <effecttype>motion</effecttype>
                <mediatype>video</mediatype>
                <parameter>
                  <parameterid>scale</parameterid>
                  <name>Scale</name>
                  <valuemin>0</valuemin>
                  <valuemax>1000</valuemax>
                  <value>${zoom}</value>
                </parameter>
              </effect>
            </filter>`
          : '';

        // Video en audio aan elkaar knopen, zodat verschuiven of trimmen ze
        // samen meeneemt. Zonder deze links behandelt Premiere ze als losse
        // stukken en loopt het beeld uit de pas met het geluid.
        const links = `            <link>
              <linkclipref>c${sid}-v${i}</linkclipref>
              <mediatype>video</mediatype>
              <trackindex>1</trackindex>
              <clipindex>${i + 1}</clipindex>
            </link>
            <link>
              <linkclipref>c${sid}-a${i}</linkclipref>
              <mediatype>audio</mediatype>
              <trackindex>1</trackindex>
              <clipindex>${i + 1}</clipindex>
              <groupindex>1</groupindex>
            </link>`;

        video.push(`          <clipitem id="c${sid}-v${i}">
            <name>${naam}</name>
            <enabled>TRUE</enabled>
            <rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>
            <start>${start}</start><end>${eind}</end>
            <in>${inF}</in><out>${outF}</out>
${fileNode('            ')}
            <sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>
${links}
${motion}
          </clipitem>`);

        audio.push(`          <clipitem id="c${sid}-a${i}">
            <name>${naam}</name>
            <enabled>TRUE</enabled>
            <rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>
            <start>${start}</start><end>${eind}</end>
            <in>${inF}</in><out>${outF}</out>
            <file id="bron-1"/>
            <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
${links}
          </clipitem>`);
      }

      // De cuts staan op V2, met V1 leeg eronder. Zo houd je de onderste laag
      // vrij voor je eigen werk (b-roll, achtergrond, ondertitels) en kun je de
      // knippen erboven verschuiven zonder dat je iets anders raakt.
      const markerXml = (clip.markers ?? [])
        .map(
          (m) => `        <marker>
          <name>${xml(m.naam)}</name>
          <comment>${xml(m.notitie ?? '')}</comment>
          <in>${naarFrames(m.start)}</in>
          <out>${m.end !== undefined ? naarFrames(m.end) : -1}</out>
        </marker>`,
        )
        .join('\n');

      // Tekstkaarten als tweede beeldlaag. Premiere importeert PNG's met
      // transparantie zonder gedoe, dus de kaart staat meteen op de goede plek
      // en je hoeft hem alleen nog te restylen naar jouw huisstijl.
      const overlayItems = (clip.overlays ?? [])
        .map(
          (o, n) => `          <clipitem id="c${sid}-o${n}">
            <name>${xml(o.naam)}</name>
            <enabled>TRUE</enabled>
            <rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>
            <start>${naarFrames(o.start)}</start><end>${naarFrames(o.end)}</end>
            <in>0</in><out>${naarFrames(o.end - o.start)}</out>
            <file id="kaart-${sid}-${n}">
              <name>${xml(basename(o.pad))}</name>
              <pathurl>${xml(o.pad.startsWith('/') ? `file://localhost${encodeURI(o.pad)}` : encodeURI(o.pad))}</pathurl>
              <rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>
              <media><video><samplecharacteristics><width>1080</width><height>1920</height></samplecharacteristics></video></media>
            </file>
          </clipitem>`,
        )
        .join('\n');
      const overlayTrack = overlayItems
        ? `          <track>
${overlayItems}
          </track>`
        : '';

      return `    <sequence id="seq-${sid}">
      <name>${xml(clip.label ?? `${String(clip.nummer).padStart(2, '0')} - ${clip.titel}`)}</name>
      <duration>${cursor}</duration>
      <rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>
      <media>
        <video>
          <format><samplecharacteristics><rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate><width>${bron.breedte}</width><height>${bron.hoogte}</height></samplecharacteristics></format>
          <track>
${video.join('\n')}
          </track>
${overlayTrack}
        </video>
        <audio>
          <track>
${audio.join('\n')}
          </track>
        </audio>
      </media>
${markerXml}
    </sequence>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <project>
    <name>${xml(projectNaam)}</name>
    <children>
${sequences}
    </children>
  </project>
</xmeml>
`;
}

function xml(tekst: string): string {
  return tekst.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function basename(pad: string): string {
  return pad.split('/').pop() ?? pad;
}
