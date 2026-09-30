import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { once } from 'node:events';
import type { Kader } from './kader';
import { focusNaarX } from './kader';
import { basisZoom, type Shot } from './index';
import { deelstukken } from './scenes';
import { inhoudKader, type Box } from './graphics';
import { bouwAss, type OndertitelRegel } from './ondertitels';
import { hookDuur, planKaartenOpTijdlijn, type Huisstijl } from './tekstkaarten';

/**
 * "Afwerken in Premiere": het pakket voor een clip die goed is.
 *
 * De cloud maakt elke clip automatisch; is er één goed, dan wil de editor hem
 * afmaken zonder opnieuw te beginnen. Dit pakket zet exact dezelfde montage
 * klaar als bewerkbare lagen: de knippen uit het montageplan op de bron in
 * de hoogste kwaliteit (de 4K-secties), de kadrering als Motion-schaal en
 * -positie, ondertitels als SRT, kaarten als PNG op een eigen spoor, muziek
 * en sfx op eigen audiosporen, en de gerenderde mp4 als referentie eronder.
 *
 * Dit bestand is puur rekenwerk en bestandsopmaak (XML, SRT, ASS, zip): geen
 * ffmpeg, geen netwerk. Het verzamelen van de bestanden gebeurt in
 * afwerkpakket-bouw.ts; zo is alles hier zonder netwerk te testen
 * (scripts/test-afwerkpakket.ts).
 */

export const SEQ_B = 1080;
export const SEQ_H = 1920;

/** Een segment uit clip_plans.montageplan.clips[n].segmenten, plus de effecten van de edit-agent. */
export type AfwerkSegment = Shot & {
  /** Tijdsprong-/editorkaart: in de render alleen een marker, hier ook. */
  marker?: string;
  transcript_fragment?: string;
};

/** Een bronbestand in het pakket: een 4K-sectie of (terugval) de analysebron. */
export type PakketMedia = {
  /** Bestandsnaam in het pakket, plat naast project.xml. */
  naam: string;
  soort: 'sectie' | 'analyse';
  breedte: number;
  hoogte: number;
  /** Brontijd bij t=0 van het geluid in dit bestand. */
  bronStart: number;
  /** Brontijd bij t=0 van het beeld (bij DASH apart gemeten; zie renderbron.ts). */
  videoStart: number;
  /** Lengte van het bestand in seconden. */
  duur: number;
};

export type Motion = {
  /** Premiere Motion > Scale in procenten (100 = pixel op pixel). */
  schaal: number;
  /** Waar het midden van de clip in de sequence staat, in pixels (Premiere Motion > Position). */
  positie: { x: number; y: number };
  /** Hetzelfde als FCP7-"center": het verschil met het beeldmidden, als fractie van de sequence. */
  center: { horiz: number; vert: number };
  /** Crop-effect in procenten per kant (alleen bij een ingezoomde graphic). */
  crop?: { links: number; rechts: number; boven: number; onder: number };
};

/**
 * Een Premiere-positie in pixels naar de FCP7-"center"-waarde: (0,0) is het
 * beeldmidden, ±0,5 de rand. Staat het beeld na import een factor twee te
 * ver weg, dan is het hier (en alleen hier) dat de eenheid anders moet.
 */
export function naarCenter(positie: { x: number; y: number }): { horiz: number; vert: number } {
  return { horiz: rond(positie.x / SEQ_B - 0.5, 5), vert: rond(positie.y / SEQ_H - 0.5, 5) };
}

// ------------------------------------------------------------------ kadrering

/**
 * De uitsnede van de render ('vullend', kader.ts) als Premiere-Motion. De
 * render schaalt de bron naar een hoogte van 1920 × zoom en snijdt daar een
 * 1080×1920-venster uit met het focuspunt in het midden, geklemd binnen het
 * beeld. In Premiere is dat: schaal = die hoogte / bronhoogte, en de positie
 * zo dat hetzelfde venster in de sequence valt. Een paneel (split screen in de
 * bron) verschuift het venster binnen dat paneel.
 */
export function motionVullend(o: {
  breedte: number;
  hoogte: number;
  zoom: number;
  focusX: number;
  focusY?: number;
  paneel?: [number, number];
}): Motion {
  const doelH = Math.round((SEQ_H * o.zoom) / 2) * 2;
  const s = doelH / o.hoogte;
  const iw = o.breedte * s;
  const ih = doelH;
  const klem = (v: number, max: number) => Math.min(Math.max(v, 0), Math.max(0, max));
  let x0: number;
  if (o.paneel) {
    const pw = iw * (o.paneel[1] - o.paneel[0]);
    x0 = iw * o.paneel[0] + klem(pw * o.focusX - SEQ_B / 2, pw - SEQ_B);
  } else {
    x0 = klem(iw * o.focusX - SEQ_B / 2, iw - SEQ_B);
  }
  const y0 = klem(ih * (o.focusY ?? 0.5) - SEQ_H / 2, ih - SEQ_H);
  const positie = { x: rond(iw / 2 - x0, 2), y: rond(ih / 2 - y0, 2) };
  return { schaal: rond(s * 100, 3), positie, center: naarCenter(positie) };
}

/**
 * Passend (het blur-kader): het hele beeld op volle breedte in het midden.
 * Met een gemeten inhoud (graphics.ts) ingezoomd op die inhoud, met een
 * crop eromheen zoals de render het gebied uitsnijdt.
 */
export function motionPassend(o: { breedte: number; hoogte: number; inhoud?: Box | null }): Motion {
  if (!o.inhoud) {
    const s = SEQ_B / o.breedte;
    const positie = { x: SEQ_B / 2, y: SEQ_H / 2 };
    return { schaal: rond(s * 100, 3), positie, center: naarCenter(positie) };
  }
  const k = inhoudKader(o.inhoud, o.breedte / o.hoogte);
  const r = k.r;
  const s = k.fgB / (o.breedte * (r.x1 - r.x0));
  const iw = o.breedte * s;
  const ih = o.hoogte * s;
  const cx = iw * ((r.x0 + r.x1) / 2);
  const cy = ih * ((r.y0 + r.y1) / 2);
  const positie = { x: rond(SEQ_B / 2 + iw / 2 - cx, 2), y: rond(SEQ_H / 2 + ih / 2 - cy, 2) };
  return {
    schaal: rond(s * 100, 3),
    positie,
    center: naarCenter(positie),
    crop: {
      links: rond(r.x0 * 100, 3),
      rechts: rond((1 - r.x1) * 100, 3),
      boven: rond(r.y0 * 100, 3),
      onder: rond((1 - r.y1) * 100, 3),
    },
  };
}

/** De geblurde achtergrond onder een passend deelstuk: beeldvullend, gecentreerd. */
export function motionAchtergrond(o: { breedte: number; hoogte: number }): Motion {
  const s = Math.max(SEQ_B / o.breedte, SEQ_H / o.hoogte);
  const positie = { x: SEQ_B / 2, y: SEQ_H / 2 };
  return { schaal: rond(s * 100, 3), positie, center: naarCenter(positie) };
}

// ------------------------------------------------------------------ tijdlijn

export type VideoItem = {
  segment: number;
  volgorde: number;
  functie: string;
  deel: number;
  media: PakketMedia;
  kader: Kader;
  startF: number;
  eindF: number;
  inF: number;
  outF: number;
  motion: Motion;
  /** Alleen bij een passend deelstuk: de geblurde achtergrond op het spoor eronder. */
  achtergrond?: Motion;
  /** Wat er benaderd is (spoor → vast punt, vasthouden → marker), voor de markers. */
  opmerkingen: string[];
};

export type AudioItem = {
  segment: number;
  media: PakketMedia;
  startF: number;
  eindF: number;
  inF: number;
  outF: number;
};

export type Tijdlijn = {
  fps: number;
  duurF: number;
  video: VideoItem[];
  audio: AudioItem[];
  /** Segmenten zonder bron in het pakket (volgorde), voor de melding. */
  zonderBron: number[];
  /** Begin van elk segment op de tijdlijn (s), in volgorde. */
  segmentStarts: number[];
};

/**
 * Welk bestand een brontijdvak dekt: een sectie (de hoogste resolutie
 * eerst), anders de analysebron. Zelfde dekkingsregel als sectieVoor in
 * renderbron.ts: zowel beeld als geluid moeten het hele vak bevatten.
 */
export function kiesMedia(media: PakketMedia[], van: number, tot: number): PakketMedia | null {
  const dekt = (m: PakketMedia) => {
    const begin = Math.max(m.bronStart, m.videoStart);
    const eind = Math.min(m.bronStart, m.videoStart) + m.duur;
    return begin <= van + 1e-3 && eind >= tot - 1e-3;
  };
  const secties = media.filter((m) => m.soort === 'sectie' && dekt(m)).sort((a, b) => b.hoogte - a.hoogte);
  return secties[0] ?? media.find((m) => m.soort === 'analyse' && dekt(m)) ?? null;
}

/**
 * De tijdlijn van het pakket: per segment de bron-in en -uit, per deelstuk
 * (scènewissel in de bron, scenes.ts) een eigen clip met zijn eigen kader.
 * Framegrenzen worden cumulatief afgerond, zodat de sequence precies de som
 * van de segmenten duurt en er nergens een frame gat of overlap ontstaat.
 */
export function bouwTijdlijn(segmenten: AfwerkSegment[], media: PakketMedia[], o: { fps: number; kader: Kader }): Tijdlijn {
  const fps = o.fps;
  const f = (s: number) => Math.round(s * fps);
  const video: VideoItem[] = [];
  const audio: AudioItem[] = [];
  const zonderBron: number[] = [];
  const segmentStarts: number[] = [];
  const gesorteerd = [...segmenten].sort((a, b) => a.volgorde - b.volgorde).filter((s) => s.end > s.start);
  let cursor = 0;

  gesorteerd.forEach((seg, i) => {
    const duur = seg.end - seg.start;
    segmentStarts.push(cursor);
    const startF = f(cursor);
    const eindF = f(cursor + duur);
    const m = kiesMedia(media, seg.start, seg.end);
    if (!m) {
      zonderBron.push(seg.volgorde);
      cursor += duur;
      return;
    }
    audio.push({ segment: i, media: m, startF, eindF, inF: f(seg.start - m.bronStart), outF: f(seg.start - m.bronStart) + (eindF - startF) });

    const zoom = seg.zoom ?? basisZoom(seg);
    for (const [k, deel] of deelstukken(seg, o.kader).entries()) {
      const dStart = f(cursor + deel.van);
      const dEind = k === 0 && deel.tot >= duur - 1e-6 ? eindF : f(cursor + deel.tot);
      if (dEind <= dStart) continue;
      const opmerkingen: string[] = [];
      let motion: Motion;
      let achtergrond: Motion | undefined;
      if (deel.kader === 'blur' || deel.kader === 'origineel') {
        motion = motionPassend({ breedte: m.breedte, hoogte: m.hoogte, inhoud: deel.kader === 'blur' ? deel.inhoud : null });
        if (deel.kader === 'blur') achtergrond = motionAchtergrond(m);
      } else {
        // Het meelopende kader (spoor) wordt één vast punt: het gemiddelde
        // binnen dit deelstuk. De render beweegt daar; Premiere-keyframes
        // zetten we niet, omdat de tijdbasis van <when> bij import niet
        // eenduidig is — liever vast en goed dan bewegend en verschoven.
        let focus = seg.focusX;
        const spoor = seg.spoor?.filter((p) => p.t >= seg.start + deel.van - 0.05 && p.t <= seg.start + deel.tot + 0.05);
        if (spoor && spoor.length > 0) {
          focus = spoor.reduce((t, p) => t + p.x, 0) / spoor.length;
          const xs = spoor.map((p) => p.x);
          opmerkingen.push(`kader volgt spreker in de render (x ${Math.min(...xs).toFixed(2)}–${Math.max(...xs).toFixed(2)}); hier het gemiddelde`);
        }
        let focusY = seg.focusY;
        const spoorY = seg.spoorY?.filter((p) => p.t >= seg.start + deel.van - 0.05 && p.t <= seg.start + deel.tot + 0.05);
        if (spoorY && spoorY.length > 0) focusY = spoorY.reduce((t, p) => t + p.x, 0) / spoorY.length;
        const paneel = seg.paneel;
        const inPaneel =
          paneel && typeof focus === 'number' ? Math.min(1, Math.max(0, (focus - paneel[0]) / (paneel[1] - paneel[0]))) : focus;
        motion = motionVullend({
          breedte: m.breedte,
          hoogte: m.hoogte,
          zoom,
          focusX: focusNaarX(seg.focus, inPaneel ?? deel.persoonX ?? undefined),
          focusY,
          paneel,
        });
        if (paneel) opmerkingen.push('bron is split screen: uitsnede binnen het paneel van de spreker');
      }
      const inF = f(seg.start + deel.van - m.videoStart);
      video.push({
        segment: i,
        volgorde: seg.volgorde,
        functie: seg.functie,
        deel: k,
        media: m,
        kader: deel.kader,
        startF: dStart,
        eindF: dEind,
        inF,
        outF: inF + (dEind - dStart),
        motion,
        achtergrond,
        opmerkingen,
      });
    }
    cursor += duur;
  });

  return { fps, duurF: f(cursor), video, audio, zonderBron, segmentStarts };
}

// ------------------------------------------------------------------ kaarten, muziek, sfx

export type PakketKaart = {
  soort: 'hook' | 'context' | 'uitval' | 'plankaart' | 'rehook';
  tekst: string;
  start: number;
  end: number;
  /** Bestandsnaam van de PNG in het pakket (gezet door de bouwer). */
  naam?: string;
};

/**
 * Een uitvalrisico-fix als kaartregel — dezelfde regel als kaartRegelUit in
 * scripts/render-worker.ts (daar niet geëxporteerd): alleen een aangehaalde
 * regel of "kaart: …" is een kaart, een aanwijzing als "shot 3 ingekort" niet.
 */
export function kaartRegelUit(fix: string): string | null {
  const aangehaald = fix.match(/["“„]([^"”“]{3,48})["”]/)?.[1];
  if (aangehaald) return aangehaald;
  const kaal = fix.trim();
  if (/^(re-?hook|kaart|tekstkaart|overlay)\s*[:\-–]\s*(.{3,48})$/i.test(kaal)) {
    return kaal.replace(/^(re-?hook|kaart|tekstkaart|overlay)\s*[:\-–]\s*/i, '');
  }
  return null;
}

/**
 * De kaarten zoals de render ze inbrandt (bouwOverlays in render-worker.ts):
 * de hook vanaf 0, dan contextkaart, aangehaalde uitvalrisico's, plankaarten
 * en de re-hook van de retentie-editor. Alles na de lángste hook (zodat geen
 * hookvariant twee kaarten tegelijk toont) en nooit twee tegelijk.
 */
export function kaartenVoorClip(o: {
  segmenten: { volgorde: number; start: number; end: number; tease?: boolean }[];
  /** De hook van dít bestand (hoofdversie of hookvariant). */
  hookTekst?: string | null;
  /** Alle hookteksten van de clip; de kaarten wijken uit voor de langste. */
  hookTeksten?: string[];
  contextKaart?: string | null;
  uitvalRisicos?: { seconde: number; fix: string }[];
  planKaarten?: { shot: number; tekst: string }[];
  rehook?: { tekst?: string; start: number; end: number } | null;
}): PakketKaart[] {
  const gesorteerd = [...o.segmenten].sort((a, b) => a.volgorde - b.volgorde);
  const totaal = gesorteerd.reduce((t, sg) => t + (sg.end - sg.start), 0);
  const hooks = (o.hookTeksten ?? []).filter(Boolean);
  if (o.hookTekst && !hooks.includes(o.hookTekst)) hooks.push(o.hookTekst);
  const hookTot = hooks.length ? Math.max(...hooks.map(hookDuur)) : 0;

  const overig: PakketKaart[] = [];
  if (o.contextKaart) {
    overig.push({ soort: 'context', tekst: o.contextKaart, start: hookTot + 0.3, end: Math.min(totaal, hookTot + 0.3 + 2.2) });
  }
  for (const r of o.uitvalRisicos ?? []) {
    const tekst = kaartRegelUit(r.fix);
    if (!tekst || r.seconde < hookTot + 1 || r.seconde > totaal - 1.5) continue;
    overig.push({ soort: 'uitval', tekst, start: r.seconde, end: Math.min(totaal, r.seconde + 2.0) });
  }
  for (const k of planKaartenOpTijdlijn(gesorteerd, o.planKaarten ?? [], hookTot)) {
    overig.push({ soort: 'plankaart', tekst: k.tekst, start: k.start, end: k.end });
  }
  if (o.rehook?.tekst && o.rehook.start < totaal - 1) {
    overig.push({ soort: 'rehook', tekst: o.rehook.tekst, start: o.rehook.start, end: Math.min(totaal, o.rehook.end) });
  }
  for (let k = overig.length - 1; k >= 0; k--) {
    if (overig[k].start < hookTot) {
      if (overig[k].end - hookTot < 0.7) overig.splice(k, 1);
      else overig[k] = { ...overig[k], start: hookTot };
    }
  }
  overig.sort((a, b) => a.start - b.start);
  for (let k = 0; k + 1 < overig.length; k++) {
    if (overig[k].end > overig[k + 1].start) overig[k] = { ...overig[k], end: overig[k + 1].start };
  }
  const uit = overig.filter((x) => x.end - x.start >= 0.5);
  if (o.hookTekst) uit.unshift({ soort: 'hook', tekst: o.hookTekst, start: 0, end: Math.min(totaal, hookDuur(o.hookTekst)) });
  return uit;
}

/**
 * Waar de muziek weg is, zoals in de render: op payoff-shots en shots met sfx
 * 'stilte', vanaf 0,4 s ervoor. Overlappende vensters samengevoegd.
 */
export function muziekStiltes(segmenten: AfwerkSegment[]): { van: number; tot: number }[] {
  const vensters: { van: number; tot: number }[] = [];
  let cursor = 0;
  for (const seg of [...segmenten].sort((a, b) => a.volgorde - b.volgorde)) {
    const duur = seg.end - seg.start;
    if (duur <= 0) continue;
    if (seg.functie === 'payoff' || seg.sfx === 'stilte') {
      const v = { van: Math.max(0, cursor - 0.4), tot: cursor + duur };
      const vorige = vensters[vensters.length - 1];
      if (vorige && v.van <= vorige.tot + 1e-6) vorige.tot = Math.max(vorige.tot, v.tot);
      else vensters.push(v);
    }
    cursor += duur;
  }
  return vensters;
}

/** De sfx zoals de render ze mixt: elk op het begin van zijn segment. */
export function sfxMomenten(segmenten: AfwerkSegment[]): { slug: string; start: number; volgorde: number }[] {
  const uit: { slug: string; start: number; volgorde: number }[] = [];
  let cursor = 0;
  for (const seg of [...segmenten].sort((a, b) => a.volgorde - b.volgorde)) {
    const duur = seg.end - seg.start;
    if (duur <= 0) continue;
    if (seg.sfx && seg.sfx !== 'geen' && seg.sfx !== 'stilte') uit.push({ slug: seg.sfx, start: cursor, volgorde: seg.volgorde });
    cursor += duur;
  }
  return uit;
}

/**
 * De effecten van de edit-agent op de segmenten, precies zoals de worker ze
 * toekent: het besluit met hetzelfde volgnummer, anders het besluit op de
 * plek (volgnummer − 1). Een deelsegment (1.01) vindt zo géén besluit — ook
 * in de render niet — en houdt dus geen sfx.
 */
export function effectenOpSegmenten(
  segmenten: AfwerkSegment[],
  besluiten: { volgorde: number; sfx?: string; beeld_effect?: string; tekstkaart?: string | null }[] | null | undefined,
): AfwerkSegment[] {
  if (!besluiten?.length) return segmenten;
  return segmenten.map((seg) => {
    const besluit = besluiten.find((b) => b.volgorde === seg.volgorde) ?? besluiten[Math.min(besluiten.length - 1, (seg.volgorde ?? 1) - 1)];
    if (!besluit) return seg;
    return {
      ...seg,
      sfx: besluit.sfx ?? seg.sfx,
      beeld_effect: besluit.tekstkaart ? 'tekstkaart' : besluit.beeld_effect ?? seg.beeld_effect,
    };
  });
}

// ------------------------------------------------------------------ ondertitels

export type SrtRegel = { nr: number; start: number; end: number; tekst: string };

export function leesSrt(srt: string): SrtRegel[] {
  const tijd = (t: string) => {
    const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (!m) return NaN;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
  };
  return srt
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((blok) => blok.trim().split('\n'))
    .filter((r) => r.length >= 2 && r[1].includes('-->'))
    .map((r) => {
      const [van, tot] = r[1].split('-->');
      return { nr: Number(r[0]), start: tijd(van), end: tijd(tot), tekst: r.slice(2).join('\n') };
    })
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end));
}

/**
 * De ASS als referentie, uit de SRT van de render: zelfde regels, font en
 * accentkleur. De woordtijden binnen een regel zijn naar lengte verdeeld (de
 * SRT kent alleen regels) en de plek is de standaardhoogte — de render legt
 * een regel soms onder de kin of boven het hoofd.
 */
export function assUitSrt(srt: string, stijl?: Huisstijl | null): string {
  const regels: OndertitelRegel[] = leesSrt(srt).map((r) => {
    const woorden = r.tekst.replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
    const totaalTekens = woorden.reduce((t, w) => t + w.length, 0) || 1;
    let t = r.start;
    return {
      s: r.start,
      e: r.end,
      woorden: woorden.map((w) => {
        const d = ((r.end - r.start) * w.length) / totaalTekens;
        const woord = { w, s: t, e: t + d };
        t += d;
        return woord;
      }),
    };
  });
  return bouwAss(regels, stijl);
}

// ------------------------------------------------------------------ Premiere-XML

export type PakketStil = { naam: string; start: number; end: number; titel: string };
export type PakketAudio = { naam: string; start: number; end: number; inS: number; titel: string; volume: number; kanalen: number; duur: number };
export type PakketMarker = { start: number; end?: number; naam: string; notitie?: string };

export type PakketXmlInvoer = {
  projectNaam: string;
  sequenceNaam: string;
  tijdlijn: Tijdlijn;
  kaarten: PakketStil[];
  muziek: PakketAudio[];
  sfx: PakketAudio[];
  referentie?: { naam: string; duur: number; breedte: number; hoogte: number } | null;
  markers: PakketMarker[];
};

/**
 * Het Premiere-project (FCP7 xmeml, zoals bouwPremiereXml in fcpxml.ts) voor
 * één clip: één sequence van 1080×1920 op de clip-fps.
 *
 *  V1 achtergrond   geblurde achtergrond onder passende graphics
 *  V2 beeld         de segmenten (per deelstuk een clip) met Motion-schaal/-positie
 *  V3 kaarten       hook, context, plankaarten, re-hook als transparante PNG
 *  V4 referentie    de gerenderde mp4, uitgeschakeld: aanzetten om te vergelijken
 *  A1 spraak        gekoppeld aan V2
 *  A2 muziek        het bed, weg op de payoff zoals in de render
 *  A3 sfx
 *
 * Media staan als kale bestandsnaam in <pathurl>: alles staat plat naast
 * project.xml. Zie LEESMIJ.txt voor het koppelen.
 */
export function bouwAfwerkXml(inv: PakketXmlInvoer): string {
  const { tijdlijn } = inv;
  const fps = tijdlijn.fps;
  const tb = Math.round(fps);
  const ntsc = Math.abs(fps - tb) > 0.01 ? 'TRUE' : 'FALSE';
  const rate = `<rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>`;
  const f = (s: number) => Math.round(s * fps);

  // Elk bestand één keer volledig beschreven (de eerste keer in de
  // documentvolgorde), daarna alleen nog bij id: dubbele definities weigert
  // Premiere, en een referentie vóór de definitie ook.
  const gezien = new Set<string>();
  const fileIds = new Map<string, string>();
  const fileId = (naam: string) => {
    if (!fileIds.has(naam)) fileIds.set(naam, `f${fileIds.size + 1}`);
    return fileIds.get(naam) as string;
  };
  const fileNode = (
    ind: string,
    naam: string,
    soort: { video?: { b: number; h: number }; audio?: { kanalen: number }; duurS?: number; still?: boolean },
  ) => {
    const id = fileId(naam);
    if (gezien.has(id)) return `${ind}<file id="${id}"/>`;
    gezien.add(id);
    const media = [
      soort.video
        ? `<video><samplecharacteristics>${rate}<width>${soort.video.b}</width><height>${soort.video.h}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>`
        : '',
      soort.audio
        ? `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>${soort.audio.kanalen}</channelcount></audio>`
        : '',
    ].join('');
    return [
      `${ind}<file id="${id}">`,
      `${ind}  <name>${x(naam)}</name>`,
      `${ind}  <pathurl>${x(pathurlVoor(naam))}</pathurl>`,
      `${ind}  ${rate}`,
      soort.duurS !== undefined && !soort.still ? `${ind}  <duration>${f(soort.duurS)}</duration>` : '',
      `${ind}  <media>${media}</media>`,
      `${ind}</file>`,
    ]
      .filter(Boolean)
      .join('\n');
  };
  const mediaNode = (ind: string, m: PakketMedia) =>
    fileNode(ind, m.naam, { video: { b: m.breedte, h: m.hoogte }, audio: { kanalen: 2 }, duurS: m.duur });

  const clipitem = (o: {
    id: string;
    naam: string;
    start: number;
    eind: number;
    in: number;
    out: number;
    file: string;
    mediatype: 'video' | 'audio';
    enabled?: boolean;
    extra?: string;
  }) =>
    [
      `          <clipitem id="${o.id}">`,
      `            <name>${x(o.naam)}</name>`,
      `            <enabled>${o.enabled === false ? 'FALSE' : 'TRUE'}</enabled>`,
      `            ${rate}`,
      `            <start>${o.start}</start><end>${o.eind}</end>`,
      `            <in>${o.in}</in><out>${o.out}</out>`,
      o.file,
      `            <sourcetrack><mediatype>${o.mediatype}</mediatype><trackindex>1</trackindex></sourcetrack>`,
      o.extra ?? '',
      `          </clipitem>`,
    ]
      .filter(Boolean)
      .join('\n');

  const track = (items: string[], o: { enabled?: boolean } = {}) =>
    `        <track>\n${items.join('\n')}\n          <enabled>${o.enabled === false ? 'FALSE' : 'TRUE'}</enabled>\n          <locked>FALSE</locked>\n        </track>`;

  // V1 achtergrond
  const v1 = tijdlijn.video
    .filter((v) => v.achtergrond)
    .map((v, n) =>
      clipitem({
        id: `v1-${n + 1}`,
        naam: `${label(v)} achtergrond (blur)`,
        start: v.startF,
        eind: v.eindF,
        in: v.inF,
        out: v.outF,
        file: mediaNode('            ', v.media),
        mediatype: 'video',
        extra: [motionFilter(v.achtergrond as Motion), blurFilter()].join('\n'),
      }),
    );

  // V2 beeld, met de koppeling naar A1 op het eerste deelstuk van elk segment.
  const audioIndex = new Map(tijdlijn.audio.map((a, n) => [a.segment, n]));
  const eersteDeel = new Set<number>();
  const v2Ids: string[] = [];
  const v2 = tijdlijn.video.map((v, n) => {
    const id = `v2-${n + 1}`;
    v2Ids.push(id);
    const koppel = !eersteDeel.has(v.segment) && audioIndex.has(v.segment);
    if (koppel) eersteDeel.add(v.segment);
    const a = audioIndex.get(v.segment);
    const links = koppel && a !== undefined
      ? `            <link><linkclipref>${id}</linkclipref><mediatype>video</mediatype><trackindex>2</trackindex><clipindex>${n + 1}</clipindex></link>\n` +
        `            <link><linkclipref>a1-${a + 1}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>${a + 1}</clipindex><groupindex>1</groupindex></link>`
      : '';
    return clipitem({
      id,
      naam: `${label(v)}${v.deel > 0 ? ` deel ${v.deel + 1}` : ''} (${v.kader})`,
      start: v.startF,
      eind: v.eindF,
      in: v.inF,
      out: v.outF,
      file: mediaNode('            ', v.media),
      mediatype: 'video',
      extra: [links, motionFilter(v.motion), v.motion.crop ? cropFilter(v.motion.crop) : ''].filter(Boolean).join('\n'),
    });
  });

  // V3 kaarten
  const v3 = inv.kaarten.map((k, n) => {
    const duur = f(k.end) - f(k.start);
    return clipitem({
      id: `v3-${n + 1}`,
      naam: k.titel,
      start: f(k.start),
      eind: f(k.end),
      in: 0,
      out: duur,
      file: fileNode('            ', k.naam, { video: { b: SEQ_B, h: SEQ_H }, still: true }),
      mediatype: 'video',
    });
  });

  // V4 referentie (uit)
  const v4 = inv.referentie
    ? [
        clipitem({
          id: 'v4-1',
          naam: 'REFERENTIE — de automatische render',
          start: 0,
          eind: Math.min(tijdlijn.duurF, f(inv.referentie.duur)),
          in: 0,
          out: Math.min(tijdlijn.duurF, f(inv.referentie.duur)),
          file: fileNode('            ', inv.referentie.naam, {
            video: { b: inv.referentie.breedte, h: inv.referentie.hoogte },
            audio: { kanalen: 2 },
            duurS: inv.referentie.duur,
          }),
          mediatype: 'video',
          enabled: false,
        }),
      ]
    : [];

  // A1 spraak
  const a1 = tijdlijn.audio.map((a, n) => {
    const vIndex = tijdlijn.video.findIndex((v) => v.segment === a.segment);
    const links = vIndex >= 0
      ? `            <link><linkclipref>${v2Ids[vIndex]}</linkclipref><mediatype>video</mediatype><trackindex>2</trackindex><clipindex>${vIndex + 1}</clipindex></link>\n` +
        `            <link><linkclipref>a1-${n + 1}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>${n + 1}</clipindex><groupindex>1</groupindex></link>`
      : '';
    const v = tijdlijn.video[vIndex];
    return clipitem({
      id: `a1-${n + 1}`,
      naam: v ? label(v) : `segment ${a.segment + 1}`,
      start: a.startF,
      eind: a.eindF,
      in: a.inF,
      out: a.outF,
      file: mediaNode('            ', a.media),
      mediatype: 'audio',
      extra: links,
    });
  });

  const audioClip = (prefix: string) => (m: PakketAudio, n: number) => {
    const duur = f(m.end) - f(m.start);
    return clipitem({
      id: `${prefix}-${n + 1}`,
      naam: m.titel,
      start: f(m.start),
      eind: f(m.end),
      in: f(m.inS),
      out: f(m.inS) + duur,
      file: fileNode('            ', m.naam, { audio: { kanalen: m.kanalen }, duurS: m.duur }),
      mediatype: 'audio',
      extra: niveauFilter(m.volume),
    });
  };
  const a2 = inv.muziek.map(audioClip('a2'));
  const a3 = inv.sfx.map(audioClip('a3'));

  const markers = inv.markers
    .map(
      (m) =>
        `      <marker>\n        <name>${x(m.naam)}</name>\n        <comment>${x(m.notitie ?? '')}</comment>\n        <in>${f(m.start)}</in>\n        <out>${m.end !== undefined ? f(m.end) : -1}</out>\n      </marker>`,
    )
    .join('\n');

  const formaat = `<format><samplecharacteristics>${rate}<width>${SEQ_B}</width><height>${SEQ_H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance><colordepth>24</colordepth></samplecharacteristics></format>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <project>
    <name>${x(inv.projectNaam)}</name>
    <children>
    <sequence id="seq-1">
      <name>${x(inv.sequenceNaam)}</name>
      <duration>${tijdlijn.duurF}</duration>
      ${rate}
      <timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
      <media>
        <video>
          ${formaat}
${track(v1)}
${track(v2)}
${track(v3)}
${track(v4, { enabled: false })}
        </video>
        <audio>
          <numOutputChannels>2</numOutputChannels>
          <format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>
${track(a1)}
${track(a2)}
${track(a3)}
        </audio>
      </media>
${markers}
    </sequence>
    </children>
  </project>
</xmeml>
`;
}

/**
 * De pathurl van een bestand in het pakket. Kaal en relatief: Premiere zoekt
 * een niet-gevonden bestand dan naast project.xml, en anders vraagt hij het
 * één keer — "Relink others automatically" koppelt de rest in dezelfde map.
 * Voor volledig zonder handwerk schrijft "Koppel media (Mac).command" een
 * project-mac.xml met absolute file://-paden (zie LEESMIJ.txt).
 */
export function pathurlVoor(naam: string): string {
  return encodeURI(naam).replace(/#/g, '%23');
}

function label(v: VideoItem): string {
  return `${String(v.segment + 1).padStart(2, '0')} ${v.functie}`;
}

function motionFilter(m: Motion): string {
  return `            <filter>
              <effect>
                <name>Basic Motion</name>
                <effectid>basic</effectid>
                <effectcategory>motion</effectcategory>
                <effecttype>motion</effecttype>
                <mediatype>video</mediatype>
                <parameter authoringApp="PremierePro">
                  <parameterid>scale</parameterid>
                  <name>Scale</name>
                  <valuemin>0</valuemin>
                  <valuemax>1000</valuemax>
                  <value>${m.schaal}</value>
                </parameter>
                <parameter authoringApp="PremierePro">
                  <parameterid>center</parameterid>
                  <name>Center</name>
                  <value><horiz>${m.center.horiz}</horiz><vert>${m.center.vert}</vert></value>
                </parameter>
              </effect>
            </filter>`;
}

function cropFilter(c: NonNullable<Motion['crop']>): string {
  const p = (id: string, naam: string, v: number) =>
    `                <parameter><parameterid>${id}</parameterid><name>${naam}</name><valuemin>0</valuemin><valuemax>100</valuemax><value>${v}</value></parameter>`;
  return `            <filter>
              <effect>
                <name>Crop</name>
                <effectid>crop</effectid>
                <effectcategory>motion</effectcategory>
                <effecttype>motion</effecttype>
                <mediatype>video</mediatype>
${p('left', 'left', c.links)}
${p('right', 'right', c.rechts)}
${p('top', 'top', c.boven)}
${p('bottom', 'bottom', c.onder)}
              </effect>
            </filter>`;
}

function blurFilter(): string {
  return `            <filter>
              <effect>
                <name>Gaussian Blur</name>
                <effectid>Gaussian Blur</effectid>
                <effectcategory>Blur</effectcategory>
                <effecttype>filter</effecttype>
                <mediatype>video</mediatype>
                <parameter><parameterid>radius</parameterid><name>Radius</name><valuemin>0</valuemin><valuemax>100</valuemax><value>40</value></parameter>
              </effect>
            </filter>`;
}

function niveauFilter(volume: number): string {
  return `            <filter>
              <effect>
                <name>Audio Levels</name>
                <effectid>audiolevels</effectid>
                <effectcategory>audiolevels</effectcategory>
                <effecttype>audiolevels</effecttype>
                <mediatype>audio</mediatype>
                <parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${rond(volume, 4)}</value></parameter>
              </effect>
            </filter>`;
}

/**
 * De muziek als clips: het bed doorlopend vanaf 0, onderbroken waar de render
 * hem wegdraait (muziekStiltes), en herhaald als de clip langer is dan het bed.
 */
export function muziekClips(o: {
  naam: string;
  bedDuur: number;
  totaal: number;
  stiltes: { van: number; tot: number }[];
  /** Basisniveau (lineair, 1 = 0 dB) waar geen niveau per shot geldt. */
  volume: number;
  /** Niveau per tijdvak (de emotiecurve per shot); daar wordt ook geknipt. */
  niveaus?: { van: number; tot: number; vol: number }[];
}): PakketAudio[] {
  const delen: { van: number; tot: number }[] = [];
  let t = 0;
  for (const s of o.stiltes) {
    if (s.van > t) delen.push({ van: t, tot: Math.min(s.van, o.totaal) });
    t = Math.max(t, s.tot);
  }
  if (t < o.totaal) delen.push({ van: t, tot: o.totaal });
  const grenzen = (o.niveaus ?? []).flatMap((n) => [n.van, n.tot]);
  const uit: PakketAudio[] = [];
  for (const d of delen.filter((x) => x.tot - x.van > 0.05)) {
    // Op een lusgrens van het bed opknippen: het bed loopt in de render door
    // op de tijdlijn (stream_loop), dus bronpositie = tijdlijnpositie mod
    // bedduur. En op elke niveaugrens, zodat elk stuk één vast niveau heeft.
    let van = d.van;
    while (van < d.tot - 1e-6) {
      const inS = o.bedDuur > 0 ? van % o.bedDuur : van;
      let tot = o.bedDuur > 0 ? Math.min(d.tot, van + (o.bedDuur - inS)) : d.tot;
      for (const g of grenzen) if (g > van + 1e-6 && g < tot) tot = g;
      const niveau = o.niveaus?.find((n) => van >= n.van - 1e-6 && van < n.tot - 1e-6);
      uit.push({ naam: o.naam, start: van, end: tot, inS, titel: 'muziekbed', volume: niveau?.vol ?? o.volume, kanalen: 2, duur: o.bedDuur });
      van = tot;
    }
  }
  // Stukjes korter dan een frame zijn afrondingsruis.
  return uit.filter((m) => m.end - m.start > 0.02);
}

// ------------------------------------------------------------------ audioduur zonder ffprobe

/** Lengte van een WAV (PCM) uit de header; null als het geen leesbare WAV is. */
export function wavDuur(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let p = 12;
  let byteRate = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const grootte = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(p + 16);
    if (id === 'data') return byteRate > 0 ? Math.min(grootte, buf.length - p - 8) / byteRate : null;
    p += 8 + grootte + (grootte % 2);
  }
  return null;
}

/**
 * Lengte van een MP3: via de Xing/Info-header als die er is (VBR), anders uit
 * de bitrate van het eerste frame (CBR). Genoeg om te weten wanneer het bed
 * een lus maakt; null als het niet te lezen is.
 */
export function mp3Duur(buf: Buffer): number | null {
  let p = 0;
  if (buf.toString('ascii', 0, 3) === 'ID3' && buf.length > 10) {
    p = 10 + ((buf[6] & 0x7f) << 21) + ((buf[7] & 0x7f) << 14) + ((buf[8] & 0x7f) << 7) + (buf[9] & 0x7f);
  }
  while (p + 4 < buf.length && !(buf[p] === 0xff && (buf[p + 1] & 0xe0) === 0xe0)) p++;
  if (p + 4 >= buf.length) return null;
  const versie = (buf[p + 1] >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const laag = (buf[p + 1] >> 1) & 0x03; // 1 = Layer III
  const bitIndex = (buf[p + 2] >> 4) & 0x0f;
  const srIndex = (buf[p + 2] >> 2) & 0x03;
  const mono = ((buf[p + 3] >> 6) & 0x03) === 3;
  if (laag !== 1 || bitIndex === 0 || bitIndex === 15 || srIndex === 3) return null;
  const mpeg1 = versie === 3;
  const bitrates = mpeg1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const srs = mpeg1 ? [44100, 48000, 32000] : versie === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
  const sr = srs[srIndex];
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  const zijInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const xing = p + 4 + zijInfo;
  const tag = buf.toString('ascii', xing, xing + 4);
  if ((tag === 'Xing' || tag === 'Info') && buf.readUInt32BE(xing + 4) & 0x1) {
    return (buf.readUInt32BE(xing + 8) * samplesPerFrame) / sr;
  }
  return ((buf.length - p) * 8) / (bitrates[bitIndex] * 1000);
}

// ------------------------------------------------------------------ zip

/** CRC-32 (zip-variant), tabel eenmalig opgebouwd. */
const CRC_TABEL = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, vorige = 0): number {
  let c = (vorige ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABEL[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipItem = {
  /** Naam in de zip (mag een map bevatten, met '/'). */
  naam: string;
  /** Bestand op schijf, of de inhoud zelf. */
  pad?: string;
  data?: Buffer;
  /** Uitvoerbaar (0755), voor het .command-hulpje. */
  uitvoerbaar?: boolean;
};

/**
 * Een zip in 'store'-modus, gestreamd naar schijf. Video, PNG en mp3 zijn al
 * gecomprimeerd; inpakken zou alleen rekentijd kosten. Geen extra
 * dependency: de zip-structuur is klein genoeg om zelf te schrijven. Grenzen:
 * geen zip64, dus elk bestand en het geheel onder de 4 GB.
 */
export async function schrijfZip(doel: string, items: ZipItem[], datum = new Date()): Promise<{ bytes: number }> {
  const uit = createWriteStream(doel);
  let offset = 0;
  const schrijf = async (b: Buffer) => {
    offset += b.length;
    if (!uit.write(b)) await once(uit, 'drain');
  };
  const dosTijd = ((datum.getHours() << 11) | (datum.getMinutes() << 5) | Math.floor(datum.getSeconds() / 2)) & 0xffff;
  const dosDatum = (((datum.getFullYear() - 1980) << 9) | ((datum.getMonth() + 1) << 5) | datum.getDate()) & 0xffff;
  const centraal: Buffer[] = [];

  for (const item of items) {
    const naam = Buffer.from(item.naam, 'utf8');
    // CRC vooraf: de header staat vóór de data, en een datadescriptor achteraf
    // lezen niet alle uitpakkers even goed.
    let crc = 0;
    let grootte = 0;
    if (item.data) {
      crc = crc32(item.data);
      grootte = item.data.length;
    } else if (item.pad) {
      grootte = statSync(item.pad).size;
      for await (const stuk of createReadStream(item.pad, { highWaterMark: 1 << 20 })) crc = crc32(stuk as Buffer, crc);
    }
    if (grootte >= 0xffffffff || offset >= 0xffffffff) throw new Error(`zip: ${item.naam} past niet zonder zip64`);
    const lokaalOffset = offset;
    const kop = Buffer.alloc(30);
    kop.writeUInt32LE(0x04034b50, 0);
    kop.writeUInt16LE(20, 4);
    kop.writeUInt16LE(0x0800, 6); // utf-8-namen
    kop.writeUInt16LE(0, 8); // store
    kop.writeUInt16LE(dosTijd, 10);
    kop.writeUInt16LE(dosDatum, 12);
    kop.writeUInt32LE(crc, 14);
    kop.writeUInt32LE(grootte, 18);
    kop.writeUInt32LE(grootte, 22);
    kop.writeUInt16LE(naam.length, 26);
    kop.writeUInt16LE(0, 28);
    await schrijf(kop);
    await schrijf(naam);
    if (item.data) await schrijf(item.data);
    else if (item.pad) for await (const stuk of createReadStream(item.pad, { highWaterMark: 1 << 20 })) await schrijf(stuk as Buffer);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4); // gemaakt op unix: de bestandsrechten tellen
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dosTijd, 12);
    c.writeUInt16LE(dosDatum, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(grootte, 20);
    c.writeUInt32LE(grootte, 24);
    c.writeUInt16LE(naam.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE((((item.uitvoerbaar ? 0o100755 : 0o100644) << 16) >>> 0), 38);
    c.writeUInt32LE(lokaalOffset, 42);
    centraal.push(c, naam);
  }

  const cdStart = offset;
  for (const b of centraal) await schrijf(b);
  const eind = Buffer.alloc(22);
  eind.writeUInt32LE(0x06054b50, 0);
  eind.writeUInt16LE(items.length, 8);
  eind.writeUInt16LE(items.length, 10);
  eind.writeUInt32LE(offset - cdStart, 12);
  eind.writeUInt32LE(cdStart, 16);
  await schrijf(eind);
  uit.end();
  await once(uit, 'finish');
  return { bytes: offset };
}

/** De inhoudsopgave van een zip (voor de test en de controle na het bouwen). */
export function leesZipInhoud(buf: Buffer): { naam: string; grootte: number; crc: number; offset: number }[] {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('geen zip: eindrecord ontbreekt');
  const aantal = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const uit: { naam: string; grootte: number; crc: number; offset: number }[] = [];
  for (let i = 0; i < aantal; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: kapotte centrale map');
    const naamLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    uit.push({
      naam: buf.toString('utf8', p + 46, p + 46 + naamLen),
      crc: buf.readUInt32LE(p + 16),
      grootte: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + naamLen + extraLen + commentLen;
  }
  return uit;
}

// ------------------------------------------------------------------ hulp

function rond(v: number, decimalen: number): number {
  const f = 10 ** decimalen;
  return Math.round(v * f) / f;
}

function x(tekst: string): string {
  return tekst.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Veilige bestandsnaam (ASCII, geen spaties): Premiere en de zip lezen hem overal gelijk. */
export function veiligeNaam(tekst: string, max = 60): string {
  return (
    tekst
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max) || 'clip'
  );
}

/** Seconden als mm:ss,s voor markers en LEESMIJ. */
export function tijdTekst(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

