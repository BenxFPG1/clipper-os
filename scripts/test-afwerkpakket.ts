/**
 * Tests voor het "Afwerken in Premiere"-pakket, zonder netwerk en zonder
 * ffmpeg: kadrering als Motion, tijdlijn (in/uit-punten en duur), kaarten,
 * muziek, SRT/ASS, de XML (welgevormd, elk bestand één keer gedefinieerd)
 * en de zip (inhoud en CRC).
 *
 * Draaien: npm run test:afwerkpakket
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assUitSrt,
  bouwAfwerkXml,
  bouwTijdlijn,
  crc32,
  effectenOpSegmenten,
  kaartenVoorClip,
  kaartRegelUit,
  kiesMedia,
  leesSrt,
  leesZipInhoud,
  motionPassend,
  motionVullend,
  mp3Duur,
  muziekClips,
  muziekStiltes,
  schrijfZip,
  sfxMomenten,
  wavDuur,
  type AfwerkSegment,
  type PakketMedia,
} from '../src/lib/roughcut/afwerkpakket';
import { hookDuur } from '../src/lib/roughcut/tekstkaarten';

let fouten = 0;
let getest = 0;
function check(naam: string, ok: boolean, detail = ''): void {
  getest++;
  if (ok) console.log(`  ✓ ${naam}`);
  else {
    fouten++;
    console.log(`  ✗ ${naam}${detail ? ` — ${detail}` : ''}`);
  }
}
const dichtbij = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------------ XML-check

/**
 * Een kleine welgevormdheidscheck: elke open-tag wordt in de juiste volgorde
 * gesloten, attributen staan tussen aanhalingstekens, en elke & is een
 * geldige entiteit. Genoeg voor wat bouwAfwerkXml maakt (geen CDATA, geen
 * commentaar), zonder XML-bibliotheek.
 */
function welgevormd(xml: string): { ok: boolean; fout?: string; tags: number } {
  const stapel: string[] = [];
  let tags = 0;
  const kaal = xml.replace(/^<\?xml[^?]*\?>\s*/, '').replace(/^<!DOCTYPE[^>]*>\s*/, '');
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(kaal)) return { ok: false, fout: 'losse &', tags };
  const re = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<|>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(kaal))) {
    if (m[0] === '<' || m[0] === '>') return { ok: false, fout: `losse ${m[0]} op ${m.index}: ${kaal.slice(m.index - 30, m.index + 30)}`, tags };
    tags++;
    const [, sluit, naam, , zelf] = m;
    if (zelf) continue;
    if (sluit) {
      const open = stapel.pop();
      if (open !== naam) return { ok: false, fout: `</${naam}> sluit <${open}>`, tags };
    } else stapel.push(naam);
  }
  if (stapel.length) return { ok: false, fout: `niet gesloten: ${stapel.join(' > ')}`, tags };
  return { ok: true, tags };
}

async function main() {
  // ---------------------------------------------------------------- kadrering
  console.log('kadrering (Motion)');
  {
    // 4K-bron, zoom 1,5, focus in het midden: schaal 2880/2160, beeld gecentreerd.
    const m = motionVullend({ breedte: 3840, hoogte: 2160, zoom: 1.5, focusX: 0.5, focusY: 0.5 });
    check('schaal bij zoom 1,5 op 4K = 133,333%', dichtbij(m.schaal, 133.333, 0.001), String(m.schaal));
    check('focus midden → positie 540,960 → center 0,0', m.positie.x === 540 && m.positie.y === 960 && m.center.horiz === 0 && m.center.vert === 0, JSON.stringify(m));

    // Focus 0,3/0,44: het focuspunt valt precies op het midden van de 1080-breedte.
    const n = motionVullend({ breedte: 3840, hoogte: 2160, zoom: 1.5, focusX: 0.3, focusY: 0.44 });
    const iw = 3840 * (2880 / 2160);
    check('focuspunt X komt op x=540 in de sequence', dichtbij(iw * 0.3 - (iw / 2 - n.positie.x), 540), JSON.stringify(n.positie));
    check('positie bij focus 0,3/0,44 = 1564 / 1132,8', dichtbij(n.positie.x, 1564) && dichtbij(n.positie.y, 1132.8), JSON.stringify(n.positie));
    check('center = positie/sequence − 0,5', dichtbij(n.center.horiz, 1564 / 1080 - 0.5, 1e-4) && dichtbij(n.center.vert, 1132.8 / 1920 - 0.5, 1e-4));

    // Klem aan de rand, zoals de crop-expressie in kader.ts.
    const k = motionVullend({ breedte: 3840, hoogte: 2160, zoom: 1.5, focusX: 0.02 });
    check('focus tegen de linkerrand: uitsnede geklemd (linkerrand bron = linkerrand beeld)', dichtbij(k.positie.x - iw / 2, 0), JSON.stringify(k.positie));

    // 1080p zonder zoom: 177,78%.
    const h = motionVullend({ breedte: 1920, hoogte: 1080, zoom: 1, focusX: 0.5 });
    check('1080p zoom 1 → 177,778%', dichtbij(h.schaal, 177.778, 0.001), String(h.schaal));

    // Zelfde uitsnede op 4K en 1080p: dezelfde positie in de sequence.
    const a = motionVullend({ breedte: 3840, hoogte: 2160, zoom: 1.2, focusX: 0.62, focusY: 0.4 });
    const b = motionVullend({ breedte: 1920, hoogte: 1080, zoom: 1.2, focusX: 0.62, focusY: 0.4 });
    check('uitsnede resolutie-onafhankelijk (4K en 1080p zelfde positie)', dichtbij(a.positie.x, b.positie.x) && dichtbij(a.positie.y, b.positie.y));

    const p = motionPassend({ breedte: 3840, hoogte: 2160 });
    check('passend: volle breedte (28,125%), gecentreerd', dichtbij(p.schaal, 28.125) && p.center.horiz === 0 && p.center.vert === 0);
    const box = { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.6 };
    const q = motionPassend({ breedte: 3840, hoogte: 2160, inhoud: box });
    const s = q.schaal / 100;
    const inhoudMidden = { x: 3840 * s * 0.5, y: 2160 * s * 0.4 };
    // Het midden van het uitgesneden gebied ligt op het sequencemidden; de
    // inhoud zit daar per constructie binnen.
    check('ingezoomde graphic: groter dan passend, met crop', q.schaal > p.schaal && Boolean(q.crop), JSON.stringify(q));
    const cropMidden = {
      x: 3840 * s * ((q.crop!.links + (100 - q.crop!.rechts)) / 200),
      y: 2160 * s * ((q.crop!.boven + (100 - q.crop!.onder)) / 200),
    };
    check(
      'ingezoomde graphic: gecropt gebied gecentreerd in beeld',
      dichtbij(q.positie.x - (3840 * s) / 2 + cropMidden.x, 540, 0.5) && dichtbij(q.positie.y - (2160 * s) / 2 + cropMidden.y, 960, 0.5),
    );
    check('ingezoomde graphic: inhoud valt binnen het beeld', (() => {
      const x = q.positie.x - (3840 * s) / 2 + inhoudMidden.x;
      const y = q.positie.y - (2160 * s) / 2 + inhoudMidden.y;
      return x > 0 && x < 1080 && y > 0 && y < 1920;
    })());
  }

  // ---------------------------------------------------------------- tijdlijn
  console.log('tijdlijn');
  const fps = 25;
  const segmenten: AfwerkSegment[] = [
    { volgorde: 1, start: 273.315, end: 275.26, functie: 'hook', zoom: 1.515, focusX: 0.4875, focusY: 0.4425, spanning: 5 },
    { volgorde: 1.01, start: 275.58, end: 276.645, functie: 'hook', zoom: 1.635, focusX: 0.4875, focusY: 0.4425, spanning: 5 },
    { volgorde: 2, start: 276.645, end: 283.84, functie: 'setup', focusX: 0.489, focusY: 0.415, spanning: 6 },
    { volgorde: 3, start: 283.84, end: 286.58, functie: 'escalatie', focusX: 0.478, focusY: 0.4155, spanning: 8, marker: '2,5 minuut later' },
    { volgorde: 4, start: 293.17, end: 294.935, functie: 'barst', focusX: 0.4965, focusY: 0.442, spanning: 9 },
    { volgorde: 5, start: 294.805, end: 302.26, functie: 'payoff', zoom: 1.191, focusX: 0.4945, focusY: 0.4625, spanning: 9 },
    {
      volgorde: 6,
      start: 400,
      end: 404,
      functie: 'bewijs',
      focusX: 0.5,
      scenes: [
        { van: 399, tot: 401.5, gezicht: true },
        { van: 401.5, tot: 405, gezicht: false, inhoud: { x0: 0.2, y0: 0.25, x1: 0.8, y1: 0.75 } },
      ],
    },
  ];
  const media: PakketMedia[] = [
    // Sectie met apart gemeten beeld-offset (DASH): geluid t=0 op 270,0, beeld op 270,12.
    { naam: 'bron-2160p-270.0-300.0.mp4', soort: 'sectie', breedte: 3840, hoogte: 2160, bronStart: 270.0, videoStart: 270.12, duur: 30 },
    { naam: 'bron-1440p-290.0-310.0.mp4', soort: 'sectie', breedte: 2560, hoogte: 1440, bronStart: 290.0, videoStart: 290.0, duur: 20 },
    { naam: 'bron-analyse-1080p.mp4', soort: 'analyse', breedte: 1920, hoogte: 1080, bronStart: 0, videoStart: 0, duur: 600 },
  ];
  check('kiesMedia: 4K-sectie wint als hij het vak dekt', kiesMedia(media, 280, 285)?.naam === media[0].naam);
  check('kiesMedia: vak over de sectiegrens → andere sectie', kiesMedia(media, 294.8, 302.3)?.naam === media[1].naam);
  check('kiesMedia: niet gedekt → analysebron', kiesMedia(media, 400, 404)?.soort === 'analyse');
  check('kiesMedia: beeld-offset telt mee (vak vóór videoStart niet gedekt)', kiesMedia(media.slice(0, 1), 270.05, 272) === null);

  const t = bouwTijdlijn(segmenten, media, { fps, kader: 'vullend' });
  const som = segmenten.reduce((s, x) => s + (x.end - x.start), 0);
  check('sequence-duur = som van de segmenten (in frames)', t.duurF === Math.round(som * fps), `${t.duurF} vs ${Math.round(som * fps)}`);
  const hoofd = t.video.filter((v) => v.deel === 0);
  check('één beeldclip per segment (plus deelstukken)', hoofd.length === segmenten.length && t.video.length === segmenten.length + 1);
  check('één geluidsclip per segment', t.audio.length === segmenten.length);
  const aansluitend = t.video.every((v, i) => i === 0 || v.startF === t.video[i - 1].eindF) && t.video[0].startF === 0 && t.video.at(-1)!.eindF === t.duurF;
  check('beeldclips sluiten naadloos aan (geen gat, geen overlap)', aansluitend);
  const a1 = t.audio.every((a, i) => i === 0 || a.startF === t.audio[i - 1].eindF);
  check('geluidsclips sluiten naadloos aan', a1);
  const v1 = t.video[0];
  check(
    'in-punt beeld = (bron-start − videoStart) × fps',
    v1.inF === Math.round((273.315 - 270.12) * fps) && v1.outF - v1.inF === v1.eindF - v1.startF,
    `${v1.inF}`,
  );
  check('in-punt geluid = (bron-start − bronStart) × fps', t.audio[0].inF === Math.round((273.315 - 270.0) * fps), `${t.audio[0].inF}`);
  const payoff = t.video.find((v) => v.functie === 'payoff')!;
  check('payoff uit de 1440p-sectie met in-punt 4,805 s', payoff.media.hoogte === 1440 && payoff.inF === Math.round(4.805 * fps));
  check('zoom uit het montageplan → schaal', dichtbij(v1.motion.schaal, (Math.round((1920 * 1.515) / 2) * 2 / 2160) * 100, 0.001), String(v1.motion.schaal));
  const graphic = t.video.find((v) => v.segment === 6 && v.deel === 1);
  check('scènewissel → tweede deelstuk passend met achtergrond', graphic?.kader === 'blur' && Boolean(graphic.achtergrond) && Boolean(graphic.motion.crop));
  check('deelstuk begint op de bronknip (1,5 s in het shot)', graphic?.startF === Math.round((t.segmentStarts[6] + 1.5) * fps));
  check('deelstuk in-punt = bronknip in de analysebron', graphic?.inF === Math.round(401.5 * fps));

  // Effecten van de edit-agent: deelsegment 1.01 krijgt geen besluit (zoals de worker).
  const metEffect = effectenOpSegmenten(segmenten, [
    { volgorde: 1, sfx: 'sub_boom', beeld_effect: 'geen' },
    { volgorde: 4, sfx: 'impact', beeld_effect: 'shake' },
  ]);
  const sfx = sfxMomenten(metEffect);
  check('sfx op het begin van hun segment', sfx.length >= 2 && sfx[0].start === 0 && sfx[0].slug === 'sub_boom');
  check('deelsegment 1.01 erft geen sfx', metEffect[1].sfx === undefined);

  // ---------------------------------------------------------------- kaarten
  console.log('kaarten');
  const hook = 'Platina is niet goud. En dat is het punt.';
  const kaarten = kaartenVoorClip({
    segmenten,
    hookTekst: hook,
    hookTeksten: [hook, 'Onthoud deze zin: zeldzaam, onmisbaar, kwetsbaar.'],
    planKaarten: [
      { shot: 2, tekst: 'Zeldzaam. Onmisbaar. Kwetsbaar.' },
      { shot: 3, tekst: 'Klinkt als een pleidooi. Maar.' },
      { shot: 5, tekst: 'Goud: vertrouwen.' },
    ],
    uitvalRisicos: [{ seconde: 16, fix: 'op 16s de re-hookkaart "Klinkt als een pleidooi. Maar." zetten' }],
  });
  const hookTot = Math.max(hookDuur(hook), hookDuur('Onthoud deze zin: zeldzaam, onmisbaar, kwetsbaar.'));
  check('hook op 0 met zijn eigen leesduur', kaarten[0].soort === 'hook' && kaarten[0].start === 0 && dichtbij(kaarten[0].end, hookDuur(hook)));
  check('andere kaarten pas na de langste hook', kaarten.slice(1).every((k) => k.start >= hookTot - 1e-6));
  check('kaarten overlappen niet', kaarten.slice(1).every((k, i, a) => i === 0 || k.start >= a[i - 1].end - 1e-6));
  check('kaartregel uit een uitvalrisico-fix', kaartRegelUit('zet de kaart "Wacht, er is meer" erbij') === 'Wacht, er is meer' && kaartRegelUit('shot 3 inkorten') === null);

  // ---------------------------------------------------------------- muziek
  console.log('muziek en audio');
  const stiltes = muziekStiltes(segmenten);
  const payoffStart = t.segmentStarts[5];
  check('muziek weg vanaf 0,4 s vóór de payoff', stiltes.length === 1 && dichtbij(stiltes[0].van, payoffStart - 0.4));
  const bed = muziekClips({ naam: 'muziek.mp3', bedDuur: 10, totaal: som, stiltes, volume: 0.34, niveaus: [{ van: 0, tot: 3, vol: 0.32 }] });
  check('muziek niet in het stiltevenster', bed.every((m) => m.end <= stiltes[0].van + 1e-6 || m.start >= stiltes[0].tot - 1e-6));
  check('bed loopt door en maakt een lus op de bedduur', bed.some((m) => m.inS === 0 && dichtbij(m.start, 10)));
  check('niveau per shot op de muziek', bed[0].volume === 0.32 && bed.find((m) => m.start >= 3)?.volume === 0.34);
  const wav = await readFile(join(process.cwd(), 'assets', 'sfx', 'impact.wav'));
  check('wav-duur uit de header (impact 0,35 s)', dichtbij(wavDuur(wav) ?? 0, 0.35, 0.005));
  const mp3 = await readFile(join(process.cwd(), 'assets', 'muziek', 'spanningsbed.mp3'));
  check('mp3-duur zonder ffprobe (bed 90 s)', dichtbij(mp3Duur(mp3) ?? 0, 90, 0.5), String(mp3Duur(mp3)));

  // ---------------------------------------------------------------- ondertitels
  console.log('ondertitels');
  const srt = '1\n00:00:00,231 --> 00:00:01,131\nPlatina is\n\n2\n00:00:01,131 --> 00:00:02,151\nniet goud.\n\n3\n00:01:02,5 --> 00:01:03,000\nlaatste regel\n';
  const regels = leesSrt(srt);
  check('SRT gelezen: 3 regels', regels.length === 3);
  check('SRT-tijden op de milliseconde', dichtbij(regels[0].start, 0.231, 1e-6) && dichtbij(regels[1].end, 2.151, 1e-6) && dichtbij(regels[2].start, 62.5, 1e-6));
  const ass = assUitSrt(srt);
  const dialogen = ass.split('\n').filter((r) => r.startsWith('Dialogue:'));
  check('ASS: één dialoogregel per woord', dialogen.length === 6, String(dialogen.length));
  check('ASS: eerste woord start op de SRT-tijd', dialogen[0].includes('0:00:00.23'));

  // ---------------------------------------------------------------- XML
  console.log('Premiere-XML');
  const xml = bouwAfwerkXml({
    projectNaam: 'Test & co <proef>',
    sequenceNaam: '03 - Platina is niet goud',
    tijdlijn: t,
    kaarten: kaarten.map((k, i) => ({ naam: `kaart-${i + 1}.png`, start: k.start, end: k.end, titel: `${k.soort}: ${k.tekst}` })),
    muziek: bed,
    sfx: sfx.map((m) => ({ naam: `sfx-${m.slug}.wav`, start: m.start, end: m.start + 0.35, inS: 0, titel: m.slug, volume: 0.18, kanalen: 1, duur: 0.35 })),
    referentie: { naam: 'referentie-render.mp4', duur: som, breedte: 1080, hoogte: 1920 },
    markers: [{ start: 0, naam: 'BRIEFING', notitie: 'hook "x" & <y>' }],
  });
  const wg = welgevormd(xml);
  check('XML is welgevormd', wg.ok, wg.fout);
  check('sequence 1080x1920 op 25 fps', /<format><samplecharacteristics><rate><timebase>25<\/timebase>.*?<width>1080<\/width><height>1920<\/height>/.test(xml));
  check('sequence-duur in de XML = som van de segmenten', xml.includes(`<duration>${Math.round(som * fps)}</duration>`));
  const ids = [...xml.matchAll(/<file id="([^"]+)">/g)].map((m) => m[1]);
  check('elk bestand precies één keer volledig gedefinieerd', new Set(ids).size === ids.length);
  const eersteRef = [...xml.matchAll(/<file id="([^"]+)"\/?>/g)];
  const gedefinieerd = new Set<string>();
  let refVoorDef = false;
  for (const m of eersteRef) {
    if (m[0].endsWith('/>')) {
      if (!gedefinieerd.has(m[1])) refVoorDef = true;
    } else gedefinieerd.add(m[1]);
  }
  check('geen verwijzing naar een bestand vóór zijn definitie', !refVoorDef);
  const clipIns = [...xml.matchAll(/<clipitem id="v2-(\d+)">[\s\S]*?<in>(\d+)<\/in><out>(\d+)<\/out>/g)].map((m) => [Number(m[2]), Number(m[3])]);
  check('in/uit-punten in de XML = tijdlijn', clipIns.length === t.video.length && clipIns.every(([i, o], n) => i === t.video[n].inF && o === t.video[n].outF));
  check('schaal en center staan als Basic Motion op de clip', xml.includes(`<value>${v1.motion.schaal}</value>`) && xml.includes(`<horiz>${v1.motion.center.horiz}</horiz>`));
  check('pathurl is de kale bestandsnaam', /<pathurl>bron-2160p-270\.0-300\.0\.mp4<\/pathurl>/.test(xml));
  check('referentiespoor staat uit', /<clipitem id="v4-1">[\s\S]*?<enabled>FALSE<\/enabled>/.test(xml));
  check('beeld en geluid gekoppeld', /<clipitem id="a1-1">[\s\S]*?<linkclipref>v2-1<\/linkclipref>/.test(xml));
  check('marker met briefing (ge-escaped)', xml.includes('hook &quot;x&quot; &amp; &lt;y&gt;'));

  // ---------------------------------------------------------------- zip
  console.log('zip');
  const map = await mkdtemp(join(tmpdir(), 'afwerk-test-'));
  try {
    const verwacht = [...new Set([...xml.matchAll(/<pathurl>([^<]+)<\/pathurl>/g)].map((m) => decodeURI(m[1])))];
    const extra = ['project.xml', 'ondertitels.srt', 'ondertitels-referentie.ass', 'LEESMIJ.txt', 'Koppel media (Mac).command'];
    for (const [i, naam] of [...verwacht, ...extra].entries()) {
      await writeFile(join(map, naam), naam === 'project.xml' ? xml : Buffer.from(`inhoud ${i} ${naam}`.repeat(50)));
    }
    const zipPad = join(map, 'pakket.zip');
    const items = [...verwacht, ...extra].map((naam) => ({ naam: `pakket/${naam}`, pad: join(map, naam), uitvoerbaar: naam.endsWith('.command') }));
    const { bytes } = await schrijfZip(zipPad, items);
    const buf = await readFile(zipPad);
    check('zipgrootte klopt met wat er geschreven is', buf.length === bytes);
    const inhoud = leesZipInhoud(buf);
    const namen = new Set(inhoud.map((x) => x.naam));
    check('zip bevat elk bestand waar de XML naar verwijst', verwacht.every((n) => namen.has(`pakket/${n}`)), verwacht.filter((n) => !namen.has(`pakket/${n}`)).join(', '));
    check('zip bevat project.xml, SRT, ASS, LEESMIJ en het koppelhulpje', extra.every((n) => namen.has(`pakket/${n}`)));
    let crcGoed = true;
    for (const it of inhoud) {
      const naamLen = buf.readUInt16LE(it.offset + 26);
      const extraLen = buf.readUInt16LE(it.offset + 28);
      const data = buf.subarray(it.offset + 30 + naamLen + extraLen, it.offset + 30 + naamLen + extraLen + it.grootte);
      if (crc32(data) !== it.crc || buf.readUInt32LE(it.offset) !== 0x04034b50) crcGoed = false;
    }
    check('CRC en lokale headers van elk bestand kloppen', crcGoed);
    check('crc32 bekende waarde ("123456789" = cbf43926)', crc32(Buffer.from('123456789')).toString(16) === 'cbf43926');
  } finally {
    await rm(map, { recursive: true, force: true });
  }

  console.log(`\n${getest - fouten}/${getest} geslaagd`);
  if (fouten > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
