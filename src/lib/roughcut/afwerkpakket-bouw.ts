import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { db } from '../supabase';
import { r2Download } from '../r2';
import { muziekProvider } from '../muziek';
import { bewaarInBronCache, bronSleutel, haalUitBronCache, lijstBronCache } from './broncache';
import { haalRenderSecties, sectiePlan, type SectieBestand } from './renderbron';
import { instelling } from './instellingen';
import type { Kader } from './kader';
import { tekenHookKaart, tekenKaart, type Huisstijl } from './tekstkaarten';
import {
  assUitSrt,
  bouwAfwerkXml,
  bouwTijdlijn,
  effectenOpSegmenten,
  kaartenVoorClip,
  kiesMedia,
  leesSrt,
  mp3Duur,
  muziekClips,
  muziekStiltes,
  schrijfZip,
  sfxMomenten,
  tijdTekst,
  veiligeNaam,
  wavDuur,
  type AfwerkSegment,
  type PakketAudio,
  type PakketMarker,
  type PakketMedia,
  type PakketStil,
} from './afwerkpakket';
import { afwerkBasis, afwerkSleutel } from './afwerkstatus';

/**
 * Bouwt het "Afwerken in Premiere"-pakket voor één bestand van een render:
 * alles verzamelen (bron, kaarten, audio, ondertitels, referentie), het
 * project schrijven en zippen. Draait in GitHub Actions
 * (.github/workflows/afwerkpakket.yml → scripts/afwerkpakket.ts) of lokaal;
 * niet op Vercel — de 4K-secties zijn tientallen MB's per stuk, en een
 * ontbrekende sectie ophalen vraagt yt-dlp en ffmpeg.
 *
 * De montage zelf komt uit clip_plans.montageplan (wat de poort vastlegde en
 * de render uitvoerde), de effecten uit edit_beslissingen, de kaarten uit het
 * plan — dezelfde bronnen als de render, dus hetzelfde resultaat.
 */

export type AfwerkResultaat = {
  map: string;
  basis: string;
  bestanden: string[];
  meldingen: string[];
  zipPad?: string;
  zipSleutel?: string;
  bytes?: number;
};

type Bestand = {
  naam: string;
  pad: string;
  bytes?: number;
  hook_variant?: number;
  hook_tekst?: string;
  vingerafdruk?: { duurS?: number };
  keuring?: { regels?: { naam: string; detail: string }[] } | null;
};

export async function bouwAfwerkpakket(o: {
  renderJobId: string;
  bestandNaam: string;
  /** Werkmap; het pakket komt in <werkmap>/<basis>/. */
  werkmap: string;
  /**
   * Secties die niet (meer) in de R2-cache staan zelf ophalen in de hoogste
   * kwaliteit (yt-dlp + ffmpeg voor de uitlijning). Zonder: de analysebron
   * (1080p) als terugval, met een melding.
   */
  haalSecties?: boolean;
  zip?: boolean;
  upload?: boolean;
  log?: (m: string) => void;
}): Promise<AfwerkResultaat> {
  const log = o.log ?? (() => {});
  const meldingen: string[] = [];
  const supabase = db();

  // ---------------------------------------------------------------- gegevens
  const { data: job, error: jobFout } = await supabase
    .from('render_jobs')
    .select('id, video_id, clip_index, titel, status, bestanden, gestart_at, klaar_at')
    .eq('id', o.renderJobId)
    .single();
  if (jobFout || !job) throw new Error(`Render ${o.renderJobId} niet gevonden`);
  const bestand = ((job.bestanden ?? []) as Bestand[]).find((b) => b.naam === o.bestandNaam);
  if (!bestand) throw new Error(`Bestand ${o.bestandNaam} hoort niet bij deze render`);
  const videoId = job.video_id as string;

  const { data: video } = await supabase
    .from('videos')
    .select('id, title, fps, breedte, hoogte, source_url, duration_seconds, campaign_id')
    .eq('id', videoId)
    .single();
  if (!video) throw new Error('Video niet gevonden');

  const { data: planRij } = await supabase
    .from('clip_plans')
    .select('plan, montageplan, edit_beslissingen')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (!planRij) throw new Error('Geen clip-plan voor deze video');

  const nummer = (job.clip_index as number | null) ?? Number(o.bestandNaam.match(/^(\d+)-/)?.[1] ?? NaN);
  if (!Number.isFinite(nummer)) throw new Error('Clipnummer niet te bepalen');

  type MpClip = {
    segmenten?: AfwerkSegment[];
    srt?: string;
    vastgelegd_at?: string;
    retentie?: { rehook?: { tekst?: string; start: number; end: number } | null } | null;
    sfx_plan?: { slug: string; t: number; volume?: number }[];
    sfxPlan?: { slug: string; t: number; volume?: number }[];
  };
  const mpClip = ((planRij.montageplan as { clips?: Record<string, MpClip> } | null)?.clips ?? {})[String(nummer)];
  if (!mpClip?.segmenten?.length) {
    throw new Error(`Geen vastgelegd montageplan voor clip ${nummer}: render opnieuw, dan legt de worker het vast.`);
  }
  // Het montageplan staat bij het nieuwste plan en wordt bij elke render van
  // deze clip overschreven. Is het vastgelegd buiten deze render, dan is het
  // mogelijk een andere montage dan de mp4 — dat hoort de editor te weten.
  if (mpClip.vastgelegd_at && job.gestart_at && job.klaar_at) {
    const t = Date.parse(mpClip.vastgelegd_at);
    if (t < Date.parse(job.gestart_at as string) - 60_000 || t > Date.parse(job.klaar_at as string) + 60_000) {
      meldingen.push(
        `Het montageplan van clip ${nummer} is vastgelegd op ${mpClip.vastgelegd_at.slice(0, 16).replace('T', ' ')}, buiten deze render ` +
          '— er is sindsdien opnieuw gerenderd. Vergelijk met de referentie (V4).',
      );
    }
  }

  type PlanClip = {
    titel_intern?: string;
    hook?: { tekst_overlay?: string };
    hooks?: { tekst_overlay?: string }[];
    context_kaart?: string | null;
    uitval_risicos?: { seconde: number; fix: string }[];
    kaarten?: { shot: number; tekst: string }[];
    kader?: Kader | null;
    muziek?: string | null;
  };
  const planClip = (((planRij.plan as { clips?: PlanClip[] } | null)?.clips ?? [])[nummer - 1] ?? {}) as PlanClip;
  type EditClip = {
    clip_nummer: number;
    kader?: Kader;
    muziek?: string;
    rehook?: string | null;
    eindcontrole?: string;
    stiltemoment?: string;
    shots?: { volgorde: number; sfx?: string; beeld_effect?: string; tekstkaart?: string | null }[];
  };
  const editClip =
    ((planRij.edit_beslissingen as { clips?: EditClip[] } | null)?.clips ?? []).find((c) => c.clip_nummer === nummer) ?? null;

  const segmenten = effectenOpSegmenten(
    [...mpClip.segmenten].sort((a, b) => a.volgorde - b.volgorde),
    editClip?.shots,
  );
  const kader = (editClip?.kader ?? planClip.kader ?? 'vullend') as Kader;

  // Wat het montageplan (nog) niet vastlegt, en waar het pakket dus van de
  // render kan afwijken. Liever gezegd dan stil anders.
  const passend = Number(
    bestand.keuring?.regels?.find((r) => r.naam === 'graphics passend')?.detail.match(/(\d+) passend/)?.[1] ?? 0,
  );
  if (passend > 0 && !segmenten.some((sg) => sg.scenes?.length)) {
    meldingen.push(
      `De render toonde ${passend} graphic-deelstuk(ken) passend (hele graphic met blur); het montageplan bevat de scènes niet, ` +
        'dus hier staan die stukken vullend. Zet de referentie (V4) aan en maak die clips passend (Scale naar volle breedte).',
    );
  }
  const zonderZoom = segmenten.filter((sg) => sg.zoom === undefined).length;
  if (zonderZoom > 0) {
    meldingen.push(
      `${zonderZoom} segment(en) zonder vastgelegde zoom: de schaal is geschat en kan wijder zijn dan in de render (zie de marker per segment).`,
    );
  }
  const fps = typeof video.fps === 'number' && video.fps > 0 ? (video.fps as number) : 25;
  if (!(typeof video.fps === 'number' && video.fps > 0)) meldingen.push('Framerate van de bron niet gemeten; 25 fps aangenomen.');

  let stijl: Huisstijl = {};
  if (video.campaign_id) {
    const { data: c } = await supabase.from('campaigns').select('huisstijl').eq('id', video.campaign_id).single();
    stijl = ((c?.huisstijl as Huisstijl | null) ?? {}) as Huisstijl;
  }

  const basis = afwerkBasis(o.bestandNaam);
  const map = join(o.werkmap, basis);
  await rm(map, { recursive: true, force: true });
  await mkdir(map, { recursive: true });
  const tijdelijk = join(o.werkmap, `${basis}-tmp`);
  await mkdir(tijdelijk, { recursive: true });

  // ---------------------------------------------------------------- bron
  // Kandidaten: de 4K-secties in de R2-cache (alleen de kleine metadata
  // eerst), eventueel zelf opgehaalde secties, en als laatste de analysebron.
  type Kandidaat = PakketMedia & { r2?: string; lokaal?: string };
  const kandidaten: Kandidaat[] = [];
  const naamVoor = (s: { van: number; tot: number; hoogte: number }) => `bron-${s.hoogte}p-${s.van.toFixed(1)}-${s.tot.toFixed(1)}.mp4`;
  const naarKandidaat = (s: SectieBestand, extra: { r2?: string; lokaal?: string }): Kandidaat => ({
    naam: naamVoor(s),
    soort: 'sectie',
    breedte: s.breedte,
    hoogte: s.hoogte,
    bronStart: s.bronStart,
    videoStart: s.videoStart ?? s.bronStart,
    duur: s.duur,
    ...extra,
  });
  for (const obj of (await lijstBronCache(bronSleutel(videoId, 'secties/'))).filter((x) => x.sleutel.endsWith('.json'))) {
    const { data } = await r2Download(obj.sleutel);
    if (!data) continue;
    try {
      const meta = JSON.parse(await data.text()) as SectieBestand;
      kandidaten.push(naarKandidaat(meta, { r2: obj.sleutel.replace(/\.json$/, '.mp4') }));
    } catch {
      // kapotte metadata: overslaan
    }
  }
  const ontbreekt = () => segmenten.filter((s) => s.end > s.start && !kiesMedia(kandidaten, s.start, s.end));
  log(`bron: ${kandidaten.length} sectie(s) in de R2-cache, ${ontbreekt().length} van ${segmenten.length} segmenten niet gedekt`);

  let analysePad: string | null = null;
  const haalAnalyse = async (): Promise<string | null> => {
    if (analysePad) return analysePad;
    const doel = join(tijdelijk, 'analyse.mp4');
    if (await haalUitBronCache(bronSleutel(videoId, 'analyse.mp4'), doel)) analysePad = doel;
    return analysePad;
  };

  if (ontbreekt().length > 0 && o.haalSecties) {
    try {
      const analyse = await haalAnalyse();
      if (!analyse) throw new Error('analysebron niet in de R2-cache');
      const crossfade = instelling('CROSSFADE');
      const plan = sectiePlan(
        ontbreekt().map((s) => ({ start: s.start - crossfade, end: s.end + crossfade })),
        { duur: (video.duration_seconds as number | null) ?? null },
      );
      log(`bron: ${plan.length} sectie(s) ophalen in de hoogste kwaliteit…`);
      // Zonder videoId: de pakketbouw leest en schrijft de gedeelde rendercache
      // niet zelf (dat doet de render); de secties zijn alleen voor dit pakket.
      const r = await haalRenderSecties({
        sourceUrl: video.source_url as string,
        analyseBron: analyse,
        plan,
        map: join(tijdelijk, 'secties'),
        videoDuur: (video.duration_seconds as number | null) ?? null,
        log,
      });
      for (const s of r.secties) kandidaten.push(naarKandidaat(s, { lokaal: s.pad }));
      for (const f of r.fouten) meldingen.push(`4K-sectie niet op te halen: ${f}`);
    } catch (e) {
      meldingen.push(`Ontbrekende 4K-secties niet op te halen (${(e as Error).message.slice(0, 120)}).`);
    }
  }
  const aantalZonder = ontbreekt().length;
  if (aantalZonder > 0) {
    const analyse = await haalAnalyse();
    if (analyse) {
      kandidaten.push({
        naam: 'bron-analyse-1080p.mp4',
        soort: 'analyse',
        breedte: (video.breedte as number | null) ?? 1920,
        hoogte: (video.hoogte as number | null) ?? 1080,
        bronStart: 0,
        videoStart: 0,
        duur: (video.duration_seconds as number | null) ?? Number.MAX_SAFE_INTEGER,
        lokaal: analyse,
      });
      meldingen.push(
        `Voor ${aantalZonder} van de ${segmenten.length} segmenten stond geen sectie in hoge kwaliteit klaar ` +
          '(opgeruimd na BRONCACHE_DAGEN, of de render viel terug op de analysebron). Die staan nu op de analysebron ' +
          '(bron-analyse-1080p.mp4): zelfde knippen, lagere resolutie. Wil je 4K: vervang die clips in Premiere door de ' +
          'bron in hoge kwaliteit (Replace With Clip) — de in/uit-punten blijven gelijk.',
      );
    } else {
      meldingen.push('Geen bron in de R2-cache voor een deel van de segmenten; die staan niet op de tijdlijn.');
    }
  }

  const tijdlijn = bouwTijdlijn(segmenten, kandidaten, { fps, kader });
  if (tijdlijn.zonderBron.length) meldingen.push(`Zonder bron (niet op de tijdlijn): shot ${tijdlijn.zonderBron.join(', ')}.`);

  // Alleen de bestanden die de tijdlijn gebruikt komen in het pakket.
  const gebruikt = new Map<string, Kandidaat>();
  for (const it of [...tijdlijn.video, ...tijdlijn.audio]) gebruikt.set(it.media.naam, it.media as Kandidaat);
  for (const k of gebruikt.values()) {
    const doel = join(map, k.naam);
    if (k.lokaal) await copyFile(k.lokaal, doel);
    else if (k.r2 && !(await haalUitBronCache(k.r2, doel))) throw new Error(`Sectie ${k.r2} niet te downloaden uit R2`);
    log(`bron: ${k.naam} (${Math.round(statSync(doel).size / 1e6)} MB)`);
  }

  // ---------------------------------------------------------------- kaarten
  const hookTekst = bestand.hook_tekst ?? planClip.hook?.tekst_overlay ?? null;
  const hookTeksten = [planClip.hook?.tekst_overlay, ...(planClip.hooks ?? []).map((h) => h.tekst_overlay)]
    .filter((t): t is string => Boolean(t))
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, 3);
  const kaarten = kaartenVoorClip({
    segmenten,
    hookTekst,
    hookTeksten,
    contextKaart: planClip.context_kaart,
    uitvalRisicos: planClip.uitval_risicos,
    planKaarten: planClip.kaarten,
    rehook: mpClip.retentie?.rehook ?? null,
  });
  const stillen: PakketStil[] = [];
  for (const [i, k] of kaarten.entries()) {
    const naam = `kaart-${String(i + 1).padStart(2, '0')}-${k.soort}.png`;
    if (k.soort === 'hook') await tekenHookKaart(k.tekst, join(map, naam), stijl);
    else await tekenKaart(k.tekst, join(map, naam), stijl);
    k.naam = naam;
    stillen.push({ naam, start: k.start, end: k.end, titel: `${k.soort}: ${k.tekst.slice(0, 50)}` });
  }

  // ---------------------------------------------------------------- audio
  const totaal = tijdlijn.duurF / fps;
  const muziek: PakketAudio[] = [];
  const sfeer = editClip?.muziek ?? planClip.muziek ?? 'geen';
  if (sfeer && sfeer !== 'geen') {
    const bron = join(process.cwd(), 'assets', 'muziek', `${sfeer}.mp3`);
    if (muziekProvider() !== 'lokaal') {
      meldingen.push(`Muziek: MUZIEK_PROVIDER=${muziekProvider()} — het gegenereerde bed is niet meegeleverd; het lokale "${sfeer}" staat erin als vervanger.`);
    }
    if (existsSync(bron)) {
      const naam = `muziek-${veiligeNaam(sfeer)}.mp3`;
      await copyFile(bron, join(map, naam));
      const bedDuur = mp3Duur(readFileSync(bron)) ?? 90;
      muziek.push(
        ...muziekClips({
          naam,
          bedDuur,
          totaal,
          stiltes: muziekStiltes(segmenten),
          volume: instelling('MUZIEK_BASIS'),
          niveaus: muziekNiveaus(segmenten),
        }),
      );
    } else {
      meldingen.push(`Muziek "${sfeer}" niet gevonden in assets/muziek.`);
    }
  }

  const sfx: PakketAudio[] = [];
  const sfxPlan = mpClip.sfx_plan ?? mpClip.sfxPlan;
  const momenten = sfxPlan?.length
    ? sfxPlan.map((p) => ({ slug: p.slug, start: p.t, volume: p.volume }))
    : sfxMomenten(segmenten).map((m) => ({ slug: m.slug, start: m.start, volume: undefined as number | undefined }));
  for (const m of momenten) {
    const bron = ['wav', 'mp3'].map((ext) => join(process.cwd(), 'assets', 'sfx', `${m.slug}.${ext}`)).find((p) => existsSync(p));
    if (!bron) {
      meldingen.push(`Sfx "${m.slug}" niet gevonden in assets/sfx.`);
      continue;
    }
    const naam = `sfx-${veiligeNaam(m.slug)}${bron.slice(bron.lastIndexOf('.'))}`;
    if (!existsSync(join(map, naam))) await copyFile(bron, join(map, naam));
    const buf = readFileSync(bron);
    const duur = (bron.endsWith('.wav') ? wavDuur(buf) : mp3Duur(buf)) ?? 0.5;
    sfx.push({
      naam,
      start: m.start,
      end: Math.min(totaal, m.start + duur),
      inS: 0,
      titel: `sfx ${m.slug}`,
      volume: m.volume ?? 0.18,
      kanalen: bron.endsWith('.wav') && buf.length > 24 ? buf.readUInt16LE(22) : 2,
      duur,
    });
  }

  // ---------------------------------------------------------------- ondertitels
  if (mpClip.srt) {
    await writeFile(join(map, 'ondertitels.srt'), mpClip.srt);
    await writeFile(join(map, 'ondertitels-referentie.ass'), assUitSrt(mpClip.srt, stijl));
    const laatste = leesSrt(mpClip.srt).at(-1);
    if (laatste && laatste.end > totaal + 0.5) meldingen.push('De ondertitels lopen langer door dan de tijdlijn; controleer het einde.');
  } else {
    meldingen.push('Geen SRT in het montageplan (render zonder ondertitels, of van vóór het bewaren van de SRT).');
  }

  // ---------------------------------------------------------------- referentie
  let referentie: { naam: string; duur: number; breedte: number; hoogte: number } | null = null;
  if (await haalUitBronCache(bestand.pad, join(map, 'referentie-render.mp4'))) {
    referentie = { naam: 'referentie-render.mp4', duur: bestand.vingerafdruk?.duurS ?? totaal, breedte: 1080, hoogte: 1920 };
  } else {
    meldingen.push('De gerenderde mp4 staat niet (meer) in de opslag; geen referentiespoor.');
  }

  // ---------------------------------------------------------------- markers en project
  const markers: PakketMarker[] = [];
  const briefing = [
    hookTekst ? `HOOK: ${hookTekst}` : null,
    ...kaarten.filter((k) => k.soort !== 'hook').map((k) => `KAART ${tijdTekst(k.start)}: ${k.tekst}`),
    sfeer && sfeer !== 'geen' ? `MUZIEK: ${sfeer} (weg op de payoff, zoals in de render)` : null,
    editClip?.rehook ? `RE-HOOK (edit-agent): ${editClip.rehook}` : null,
    editClip?.stiltemoment ? `STILTE: ${editClip.stiltemoment}` : null,
    editClip?.eindcontrole ? `ZWAKSTE PLEK: ${editClip.eindcontrole}` : null,
    ...meldingen.map((m) => `LET OP: ${m}`),
  ].filter(Boolean);
  markers.push({ start: 0, naam: `BRIEFING — ${planClip.titel_intern ?? basis}`, notitie: briefing.join('\n') });
  segmenten
    .filter((s) => s.end > s.start)
    .forEach((seg, i) => {
      const start = tijdlijn.segmentStarts[i] ?? 0;
      const v = tijdlijn.video.find((x) => x.segment === i);
      const notitie = [
        seg.transcript_fragment ? `"${seg.transcript_fragment}"` : null,
        `bron ${tijdTekst(seg.start)}–${tijdTekst(seg.end)}`,
        v ? `kader ${v.kader}, schaal ${v.motion.schaal.toFixed(1)}%, positie ${v.motion.positie.x.toFixed(0)},${v.motion.positie.y.toFixed(0)}` : null,
        seg.zoom === undefined ? 'zoom: geschat (niet vastgelegd in het montageplan)' : `zoom ${seg.zoom}`,
        seg.beeld_effect && seg.beeld_effect !== 'geen' && seg.beeld_effect !== 'tekstkaart' ? `EFFECT in de render: ${seg.beeld_effect}` : null,
        seg.sfx && seg.sfx !== 'geen' ? `SFX: ${seg.sfx}` : null,
        ...(v?.opmerkingen ?? []),
      ].filter(Boolean);
      markers.push({ start, end: start + (seg.end - seg.start), naam: `${String(i + 1).padStart(2, '0')} ${seg.functie}`, notitie: notitie.join('\n') });
      if (seg.marker) markers.push({ start, naam: `KAART (alleen marker): ${seg.marker}` });
    });

  const xmlTekst = bouwAfwerkXml({
    projectNaam: `Afwerken — ${basis}`,
    sequenceNaam: `${String(nummer).padStart(2, '0')} - ${planClip.titel_intern ?? basis}`,
    tijdlijn,
    kaarten: stillen,
    muziek,
    sfx,
    referentie,
    markers,
  });
  await writeFile(join(map, 'project.xml'), xmlTekst);
  await writeFile(join(map, 'Koppel media (Mac).command'), KOPPEL_SCRIPT, { mode: 0o755 });
  await writeFile(
    join(map, 'LEESMIJ.txt'),
    leesMij({
      titel: planClip.titel_intern ?? basis,
      video: video.title as string,
      bestand: o.bestandNaam,
      fps,
      duur: totaal,
      media: [...gebruikt.values()],
      kaarten: kaarten.length,
      muziek: sfeer && sfeer !== 'geen' && muziek.length > 0 ? sfeer : null,
      sfx: sfx.map((s) => s.titel.replace(/^sfx /, '')),
      srt: Boolean(mpClip.srt),
      referentie: Boolean(referentie),
      meldingen,
    }),
  );
  await rm(tijdelijk, { recursive: true, force: true });

  const bestanden = readdirSync(map).sort();
  const res: AfwerkResultaat = { map, basis, bestanden, meldingen };
  if (o.zip || o.upload) {
    const zipPad = join(o.werkmap, `${basis}.zip`);
    const { bytes } = await schrijfZip(
      zipPad,
      bestanden.map((naam) => ({ naam: `${basis}/${naam}`, pad: join(map, naam), uitvoerbaar: naam.endsWith('.command') })),
    );
    res.zipPad = zipPad;
    res.bytes = bytes;
    log(`zip: ${basename(zipPad)} (${Math.round(bytes / 1e6)} MB, ${bestanden.length} bestanden)`);
    if (o.upload) {
      const sleutel = afwerkSleutel(o.renderJobId, o.bestandNaam, 'zip');
      if (!(await bewaarInBronCache(sleutel, zipPad))) throw new Error('Upload van de zip naar R2 mislukt');
      res.zipSleutel = sleutel;
      log(`zip in R2: ${sleutel}`);
    }
  }
  return res;
}

/**
 * Het muziekniveau per segment zoals de render het bed per shot zet (de
 * emotiecurve): rustig laat meer bed door, spanning duikt dieper weg.
 */
function muziekNiveaus(segmenten: AfwerkSegment[]): { van: number; tot: number; vol: number }[] {
  const uit: { van: number; tot: number; vol: number }[] = [];
  let cursor = 0;
  for (const seg of segmenten) {
    const duur = seg.end - seg.start;
    if (duur <= 0) continue;
    if (seg.spanning !== undefined) {
      const spanning = Math.min(10, Math.max(1, seg.spanning));
      const vol = instelling('MUZIEK_RUSTIG') - ((spanning - 1) / 9) * instelling('MUZIEK_SPANNING_BEREIK');
      uit.push({ van: cursor, tot: cursor + duur, vol: Math.round(vol * 100) / 100 });
    }
    cursor += duur;
  }
  return uit;
}

/**
 * Het hulpje voor koppelen zonder handwerk: schrijft project-mac.xml met
 * absolute file://-paden naar de bestanden in deze map. Alleen tekstbewerking
 * (perl en sed zitten standaard op elke Mac), niets wordt verplaatst.
 */
const KOPPEL_SCRIPT = `#!/bin/bash
# Maakt project-mac.xml: hetzelfde project, met de volledige paden naar de
# bestanden in deze map. Importeer daarna project-mac.xml in Premiere
# (Bestand > Importeren); de media zijn dan direct gekoppeld.
cd "$(dirname "$0")" || exit 1
MAP="$(pwd)"
URL=$(printf '%s' "$MAP" | perl -pe 's/([^A-Za-z0-9\\/._~-])/sprintf("%%%02X", ord($1))/ge')
sed "s|<pathurl>\\([^<]*\\)</pathurl>|<pathurl>file://localhost$URL/\\1</pathurl>|" project.xml > project-mac.xml
echo "Klaar: $MAP/project-mac.xml"
echo "Premiere: Bestand > Importeren > project-mac.xml"
open -R project-mac.xml
`;

function leesMij(o: {
  titel: string;
  video: string;
  bestand: string;
  fps: number;
  duur: number;
  media: PakketMedia[];
  kaarten: number;
  muziek: string | null;
  sfx: string[];
  srt: boolean;
  referentie: boolean;
  meldingen: string[];
}): string {
  const bron = o.media
    .map((m) => `  ${m.naam}  (${m.breedte}x${m.hoogte}${m.soort === 'analyse' ? ', terugval: analysebron' : ''})`)
    .join('\n');
  return `AFWERKEN IN PREMIERE — ${o.titel}
Uit: ${o.video}  ·  render: ${o.bestand}

OPENEN
1. Pak de zip uit en laat alle bestanden samen in deze map staan.
2. Premiere Pro: Bestand > Importeren (Cmd+I) > project.xml. Er komt een map met één sequence van 1080x1920, ${o.fps} fps.
3. Vraagt Premiere om media ("Link Media"): klik Zoeken, kies een bestand in deze map; met "Relink others automatically" aan koppelt hij de rest. Liever zonder vragen: dubbelklik eerst "Koppel media (Mac).command" (eerste keer: rechtsklik > Open) en importeer project-mac.xml.
4. Ondertitels: sleep ondertitels.srt in het projectpaneel en dan op de tijdlijn; Premiere maakt er een ondertitelspoor van (tijden kloppen vanaf 00:00).
5. V4 "referentie" staat uit: zet het oogje aan om met de automatische render te vergelijken.

WAT ER IN ZIT
  project.xml            de sequence (${tijdTekst(o.duur)}): knippen, kadrering (Motion schaal/positie), kaarten, audio, markers
  V1 achtergrond          geblurde achtergrond onder passende graphics (alleen als die er zijn)
  V2 beeld                elk segment als eigen clip op de hoogste bronkwaliteit, met de uitsnede van de render
  V3 kaarten              ${o.kaarten} kaart(en) als transparante PNG (kaart-*.png) op de tijden van de render
  V4 referentie           ${o.referentie ? 'referentie-render.mp4, uitgeschakeld' : '(ontbreekt)'}
  A1 spraak               gekoppeld aan V2 (harde knippen; de render legt 0,14 s crossfade op elke naad)
  A2 muziek               ${o.muziek ? `${o.muziek}, niveau per shot zoals de render, weg op de payoff (ducking onder de stem zelf zetten)` : 'geen'}
  A3 sfx                  ${o.sfx.length ? o.sfx.join(', ') : 'geen'}
  ondertitels.srt         ${o.srt ? 'dezelfde regels als ingebrand in de render' : '(ontbreekt)'}
  ondertitels-referentie.ass  de stijl van de render (font, accentkleur) als referentie
  Markers                 briefing op 0:00, per segment functie, tekst, bron-tijd, kader en effect
Bron:
${bron}

${o.meldingen.length ? `LET OP\n${o.meldingen.map((m) => `- ${m}`).join('\n')}\n` : ''}`;
}
