import 'dotenv/config';
import { readFile, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../src/lib/supabase';
import { requireEnv } from '../src/lib/env';
import { spawn } from 'node:child_process';
import { Shot, maakRuweMontage, detecteerStiltes, bepaalSegmenten, zorgVoorBron, type BurnOverlay } from '../src/lib/roughcut';
import { maakTekstkaarten, tekenHookKaart, kleurUitThumbnail, kaartenMap } from '../src/lib/roughcut/tekstkaarten';

const BUCKET = 'montages';
/** Ruim onder de 50MB-limiet van de gratis opslag; grotere clips slaan we over. */
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Pakt wachtende renderopdrachten op en maakt de ruwe montages.
 *
 * Draait in GitHub Actions, niet op Vercel: video verwerken vraagt ffmpeg en
 * minuten rekentijd, en dat heeft serverless geen van beide. De site zet
 * alleen een opdracht klaar; deze worker doet het werk en zet het resultaat in
 * Supabase Storage, waar de site een downloadlink van maakt.
 */
async function main() {
  const supabase = db();

  // Een afgebroken run (annulering, runner weg) laat de opdracht op 'bezig'
  // staan. De worker werkt per clip een hartslag bij; blijft die twintig
  // minuten uit, dan draait er niets meer en mag de opdracht opnieuw.
  const grens = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const { data: vastgelopen } = await supabase
    .from('render_jobs')
    .update({ status: 'wachtend', gestart_at: null })
    .eq('status', 'bezig')
    .lt('hartslag', grens)
    .select('id');
  if (vastgelopen?.length) console.log(`${vastgelopen.length} vastgelopen montage(s) teruggezet.`);

  const { data: jobs, error } = await supabase
    .from('render_jobs')
    .select('*, videos(title, source_url)')
    .eq('status', 'wachtend')
    .order('created_at')
    .limit(3);
  if (error) throw error;

  if (!jobs?.length) {
    console.log('Geen wachtende opdrachten.');
    return;
  }

  for (const job of jobs) {
    console.log(`\nOpdracht ${job.id} — ${job.titel ?? 'zonder titel'}`);
    await supabase
      .from('render_jobs')
      .update({ status: 'bezig', gestart_at: new Date().toISOString(), hartslag: new Date().toISOString() })
      .eq('id', job.id);

    try {
      const bestanden = await verwerk(job);
      await supabase
        .from('render_jobs')
        .update({ status: 'klaar', bestanden, klaar_at: new Date().toISOString() })
        .eq('id', job.id);
      console.log(`  klaar: ${bestanden.length} bestand(en)`);
    } catch (e) {
      const fout = e instanceof Error ? e.message : String(e);
      console.error(`  MISLUKT: ${fout}`);
      await supabase
        .from('render_jobs')
        .update({ status: 'mislukt', fout: fout.slice(0, 500), klaar_at: new Date().toISOString() })
        .eq('id', job.id);
    }
  }
}

type Job = {
  id: string;
  video_id: string;
  clip_index: number | null;
  videos: { title: string; source_url: string | null } | null;
};

async function verwerk(job: Job) {
  const supabase = db();
  const video = job.videos;
  if (!video?.source_url) throw new Error('Video heeft geen bron-URL.');

  const { data: videoRij } = await supabase
    .from('videos')
    .select('transcript, stiltes')
    .eq('id', job.video_id)
    .single();

  const { data: plan, error } = await supabase
    .from('clip_plans')
    .select('plan')
    .eq('video_id', job.video_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error) throw new Error('Geen clip-plan gevonden.');

  const clips = ((plan.plan as { clips?: unknown[] }).clips ?? []) as {
    titel_intern: string;
    shots: Shot[];
    hook?: { tekst_overlay?: string };
    kader?: 'staand' | 'vullend' | 'blur' | 'origineel';
  }[];

  const teDoen =
    job.clip_index !== null
      ? [{ clip: clips[job.clip_index - 1], nummer: job.clip_index }].filter((x) => x.clip)
      : clips.map((clip, i) => ({ clip, nummer: i + 1 }));
  if (teDoen.length === 0) throw new Error('Geen clips in het plan.');

  // Wat er in een eerdere (afgebroken) poging al gelukt is, doen we niet
  // opnieuw: de bestanden staan al in de opslag.
  const alGedaan = ((job as { bestanden?: { naam: string; pad: string; bytes: number }[] }).bestanden ??
    []) as { naam: string; pad: string; bytes: number }[];
  if (alGedaan.length > 0) {
    console.log(`  ${alGedaan.length} clip(s) uit een eerdere poging blijven staan`);
  }

  const werkmap = await mkdtemp(join(tmpdir(), 'clipper-render-'));

  // De bron staat per video op een vaste plek, niet per opdracht. Vraag je
  // eerst clip 3 en daarna clip 7 aan, dan wordt dezelfde video niet twee keer
  // gedownload — en downloaden is verreweg de traagste stap.
  const bronmap = join(tmpdir(), 'clipper-bron', job.video_id);
  const bestanden: { naam: string; pad: string; bytes: number }[] = [...alGedaan];

  await supabase
    .from('render_jobs')
    .update({ totaal: teDoen.length, gedaan: 0, voortgang: 'bronvideo ophalen…' })
    .eq('id', job.id);

  // Stiltes één keer meten per video: daarmee schuiven de knippen naar echte
  // spraakpauzes in plaats van midden in een woord.
  let stiltes = (videoRij?.stiltes as { start: number; end: number }[] | null) ?? null;

  // Huisstijl van de campagne: eenmalig de accentkleur uit de thumbnail halen
  // en bewaren, zodat kaarten en hook bij het merk horen.
  const accent = await bepaalAccent(supabase, job.video_id, video.source_url);
  const kaartMap = await kaartenMap(werkmap);

  // Bron en stiltes vóór de eerste clip klaarzetten: anders mist clip 1 de
  // spraakpauze-knippen en de gezichtsfocus die de rest wel krijgt.
  const bronPad = await zorgVoorBron(video.source_url, bronmap, (m) => console.log(`  ${m}`));
  if (!stiltes) {
    try {
      stiltes = await detecteerStiltes(bronPad);
      await supabase.from('videos').update({ stiltes }).eq('id', job.video_id);
      console.log(`  ${stiltes.length} spraakpauzes gemeten en bewaard`);
    } catch (e) {
      console.log(`  stiltes meten mislukt: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  let bronBewaard = false;
  let gedaan = 0;
  for (const { clip, nummer } of teDoen) {
    await supabase
      .from('render_jobs')
      .update({
        voortgang: `clip ${nummer}: ${clip.titel_intern.slice(0, 60)}`,
        gedaan,
        hartslag: new Date().toISOString(),
      })
      .eq('id', job.id);
    const naam = `${String(nummer).padStart(2, '0')}-${veilig(clip.titel_intern)}.mp4`;
    if (alGedaan.some((b) => b.naam === naam)) {
      gedaan += 1;
      continue;
    }
    const lokaal = join(werkmap, naam);

    console.log(`  clip ${nummer}: ${clip.titel_intern}`);

    // Definitieve segmenten eerst: geknipt op spraakpauzes, dode lucht eruit.
    // Daarop rekenen we de kaartposities en de gezichtsfocus uit.
    const segmenten = bepaalSegmenten(clip.shots, {
      transcript: (videoRij?.transcript as never) ?? undefined,
      stiltes: stiltes ?? undefined,
    });

    // Gezichtsfocus per segment (alleen waar het script geen focus opgeeft).
    await vulGezichtsFocus(bronPad, segmenten);

    // Kaarten en hook: subsegmenten (uit de dode-luchtsplitsing) krijgen geen
    // eigen kaart, anders staat dezelfde kaart er twee keer.
    const kaartSegmenten = segmenten.map((sgm) =>
      (sgm as { subKnip?: boolean }).subKnip ? { ...sgm, edit_notitie: '', beeld_effect: undefined } : sgm,
    );
    const overlays: BurnOverlay[] = await maakTekstkaarten(
      kaartSegmenten as never,
      kaartMap,
      `c${nummer}`,
      accent ?? undefined,
    );
    const hookTekst = clip.hook?.tekst_overlay;
    if (hookTekst) {
      const hookPad = join(kaartMap, `c${nummer}-hook.png`);
      await tekenHookKaart(hookTekst, hookPad, accent ?? undefined);
      overlays.unshift({ pad: hookPad, start: 0, end: 2.6 });
    }

    const montage = await maakRuweMontage({
      sourceUrl: video.source_url,
      shots: segmenten,
      alGesegmenteerd: true,
      outputPad: lokaal,
      werkmap: bronmap,
      kader: clip.kader ?? 'vullend',
      overlays,
      maxBytes: MAX_BYTES,
      onVoortgang: (m) => console.log(`     ${m}`),
    });

    // Gemeten broneigenschappen bewaren: daarmee genereert de site het
    // Premiere-projectbestand met de juiste framerate.
    if (!bronBewaard && montage.bron) {
      bronBewaard = true;
      await supabase
        .from('videos')
        .update({
          fps: montage.bron.fps,
          breedte: montage.bron.breedte,
          hoogte: montage.bron.hoogte,
        })
        .eq('id', job.video_id)
        .then(({ error: e }) => {
          if (e) console.log(`     broneigenschappen niet bewaard: ${e.message}`);
        });
    }

    const { size } = await stat(lokaal);
    if (size > MAX_BYTES) {
      console.log(`     overgeslagen: ${Math.round(size / 1e6)}MB past zelfs na comprimeren niet`);
      continue;
    }

    const pad = `${job.video_id}/${job.id}/${naam}`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(pad, await readFile(lokaal), { contentType: 'video/mp4', upsert: true });
    if (uploadError) {
      // Eén mislukte upload mag niet de hele montage weggooien: de andere
      // clips zijn al gerenderd en bruikbaar.
      console.log(`     upload mislukt, clip overgeslagen: ${uploadError.message}`);
      continue;
    }

    bestanden.push({ naam, pad, bytes: size });
    gedaan += 1;
    // Meteen wegschrijven: wordt de run halverwege afgebroken, dan blijft dit
    // werk staan in plaats van verloren te gaan.
    await supabase
      .from('render_jobs')
      .update({ gedaan, bestanden, hartslag: new Date().toISOString() })
      .eq('id', job.id);
    console.log(`     geüpload (${Math.round(size / 1e6)}MB)`);
  }

  if (bestanden.length === 0) throw new Error('Niets geüpload; alle clips waren te groot of mislukten.');
  return bestanden;
}

/**
 * Bestandsnaam voor de opslag. Supabase weigert sleutels met accenten of andere
 * niet-ASCII tekens, dus normaliseren we die weg ("Eén" wordt "Een"). Eerder
 * liep een hele montage van 33 minuten hierop stuk bij de laatste upload.
 */
/** Accentkleur van de campagne: uit de database, of eenmalig uit de thumbnail. */
async function bepaalAccent(
  supabase: ReturnType<typeof db>,
  videoId: string,
  sourceUrl: string,
): Promise<string | null> {
  const { data: v } = await supabase.from('videos').select('campaign_id').eq('id', videoId).single();
  if (!v?.campaign_id) return null;
  const { data: c } = await supabase.from('campaigns').select('huisstijl').eq('id', v.campaign_id).single();
  const bestaand = (c?.huisstijl as { accent?: string } | null)?.accent;
  if (bestaand) return bestaand;

  const kleur = await kleurUitThumbnail(sourceUrl);
  if (kleur) {
    await supabase
      .from('campaigns')
      .update({ huisstijl: { accent: kleur, bron: 'thumbnail' } })
      .eq('id', v.campaign_id);
    console.log(`  huisstijl bepaald uit thumbnail: ${kleur}`);
  }
  return kleur;
}

/**
 * Meet per segment waar het grootste gezicht staat en zet dat als focusX,
 * zodat de verticale uitsnede de spreker volgt in plaats van blind het midden
 * te pakken. Draait via OpenCV (python); ontbreekt dat, dan blijft het midden.
 */
async function vulGezichtsFocus(bronPad: string, segmenten: Shot[]): Promise<void> {
  const zonderScriptFocus = segmenten.filter((s) => !s.focus);
  if (zonderScriptFocus.length === 0) return;

  const tijden = zonderScriptFocus.map((s) => (s.start + s.end) / 2);
  try {
    const uit = await new Promise<string>((klaar, fout) => {
      const kind = spawn('python3', ['scripts/gezichten.py', bronPad, JSON.stringify(tijden)]);
      let stdout = '';
      let stderr = '';
      kind.stdout.on('data', (d) => (stdout += d));
      kind.stderr.on('data', (d) => (stderr += d));
      kind.on('error', fout);
      kind.on('close', (code) => (code === 0 ? klaar(stdout) : fout(new Error(stderr.slice(-150)))));
    });
    const posities = JSON.parse(uit.trim() || '[]') as (number | null)[];
    if (posities.length === 0) return;
    zonderScriptFocus.forEach((s, i) => {
      if (typeof posities[i] === 'number') s.focusX = posities[i] as number;
    });
    const gevonden = posities.filter((x) => x !== null).length;
    console.log(`     gezichtsfocus: ${gevonden}/${posities.length} segmenten`);
  } catch {
    // Geen OpenCV of geen leesbare video: het midden is de nette terugval.
  }
}

function veilig(naam: string): string {
  return (
    naam
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9 _-]/g, '')
      .slice(0, 45)
      .trim()
      .replace(/\s+/g, '-') || 'clip'
  );
}

requireEnv('SUPABASE_SERVICE_ROLE_KEY');

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
