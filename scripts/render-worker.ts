import 'dotenv/config';
import { readFile, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../src/lib/supabase';
import { requireEnv } from '../src/lib/env';
import { spawn } from 'node:child_process';
import { Shot, maakRuweMontage, detecteerStiltes, meetRuisvloer, bepaalSegmenten, zorgVoorBron, type BurnOverlay } from '../src/lib/roughcut';
import { maakTekstkaarten, tekenHookKaart, kleurUitThumbnail, kaartenMap, type Huisstijl } from '../src/lib/roughcut/tekstkaarten';
import { lijnShotsUit } from '../src/lib/roughcut/uitlijnen';
import { runEditAgent, beslissingenVoorClip } from '../src/lib/agents/edit';

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
    .select('plan, edit_beslissingen')
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
    muziek?: string;
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
  const stijl = await bepaalHuisstijl(supabase, job.video_id, video.source_url);
  const kaartMap = await kaartenMap(werkmap);

  // De edit-agent bepaalt hoe er gemonteerd wordt: kader, focus, ingrepen,
  // kaarten en muziek per shot. Eén call voor alle clips, bewaard bij het
  // plan — een herrender kost dus niets extra.
  let editPlan = (plan.edit_beslissingen as Awaited<ReturnType<typeof runEditAgent>> | null) ?? null;
  if (!editPlan) {
    try {
      console.log('  edit-agent ontwerpt de montage…');
      editPlan = await runEditAgent(job.video_id, { onVoortgang: (m) => console.log(`  ${m}`) });
      console.log(`  montagebeslissingen voor ${editPlan.clips.length} clip(s)`);
    } catch (e) {
      console.log(`  edit-agent niet beschikbaar (${(e as Error).message.slice(0, 80)}); standaardregels`);
    }
  }

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

  // Zit er muziek of ruis onder de spraak? Alleen dan is ruisonderdrukking
  // gerechtvaardigd; op schone bron maakt hij de stem juist slechter.
  let ruisvloer: number | null = null;
  try {
    ruisvloer = await meetRuisvloer(bronPad, stiltes ?? []);
    if (ruisvloer !== null) {
      console.log(
        `  ruisvloer ${ruisvloer} dB — ${ruisvloer > -45 ? 'muziek/ruis onder de spraak, isolatie aan' : 'schone bron, isolatie uit'}`,
      );
    }
  } catch {
    // Niet kunnen meten betekent: laat de audio met rust.
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

    // Eerst het citaat terugvinden op woordniveau: dat legt de grenzen op de
    // zin die het plan bedoelt, in plaats van op de dichtstbijzijnde stilte
    // (die kan van de verkeerde zin zijn). Daarna pas segmenteren.
    const { shots: uitgelijnd, uitgelijnd: aantalUitgelijnd } = await lijnShotsUit(bronPad, clip.shots, {
      log: (m) => console.log(`     ${m}`),
    });
    const segmenten = bepaalSegmenten(uitgelijnd, {
      transcript: (videoRij?.transcript as never) ?? undefined,
      stiltes: stiltes ?? undefined,
      uitgelijnd: aantalUitgelijnd > 0,
    });

    // Gezichtsfocus per segment (alleen waar het script geen focus opgeeft).
    await vulGezichtsFocus(bronPad, segmenten);

    // Beslissingen van de edit-agent op de segmenten leggen. Subsegmenten
    // (ontstaan door dode lucht weg te knippen) erven van hun bronshot, maar
    // krijgen de tegenovergestelde schaal zodat de naad als nadruk leest.
    const editClip = beslissingenVoorClip(editPlan, nummer);
    if (editClip) {
      let vorigeZoom: string | undefined;
      for (const seg of segmenten) {
        const besluit = editClip.shots.find((sh) => sh.volgorde === seg.volgorde)
          ?? editClip.shots[Math.min(editClip.shots.length - 1, (seg.volgorde ?? 1) - 1)];
        if (!besluit) continue;
        if (besluit.focus !== 'auto') seg.focus = besluit.focus;
        seg.beeld_effect = besluit.beeld_effect;
        seg.sfx = besluit.sfx;
        if (besluit.tekstkaart) {
          seg.edit_notitie = `${seg.edit_notitie ?? ''} "${besluit.tekstkaart}"`.trim();
          seg.beeld_effect = 'tekstkaart';
        }
        if ((seg as { subKnip?: boolean }).subKnip && besluit.beeld_effect === vorigeZoom) {
          seg.beeld_effect = besluit.beeld_effect === 'punch_in' ? 'geen' : 'punch_in';
        }
        vorigeZoom = seg.beeld_effect;
      }
    }

    // Kaarten en hook: subsegmenten (uit de dode-luchtsplitsing) krijgen geen
    // eigen kaart, anders staat dezelfde kaart er twee keer.
    const kaartSegmenten = segmenten.map((sgm) =>
      (sgm as { subKnip?: boolean }).subKnip ? { ...sgm, edit_notitie: '', beeld_effect: undefined } : sgm,
    );
    const overlays: BurnOverlay[] = await maakTekstkaarten(
      kaartSegmenten as never,
      kaartMap,
      `c${nummer}`,
      stijl,
    );
    const hookTekst = clip.hook?.tekst_overlay;
    if (hookTekst) {
      const hookPad = join(kaartMap, `c${nummer}-hook.png`);
      await tekenHookKaart(hookTekst, hookPad, stijl);
      overlays.unshift({ pad: hookPad, start: 0, end: 2.6 });
    }

    const montage = await maakRuweMontage({
      sourceUrl: video.source_url,
      shots: segmenten,
      alGesegmenteerd: true,
      outputPad: lokaal,
      werkmap: bronmap,
      kader: editClip?.kader ?? clip.kader ?? 'vullend',
      overlays,
      // Eigen gelicenseerde audio uit assets/: muziekbed met ducking en
      // stiltevensters, sfx op de shots die erom vragen. Ontbreekt een
      // bestand, dan wordt het stil overgeslagen.
      muziekPad: (() => {
        const keuze = editClip?.muziek ?? clip.muziek;
        return keuze && keuze !== 'geen'
          ? join(process.cwd(), 'assets', 'muziek', `${keuze}.mp3`)
          : undefined;
      })(),
      sfxMap: join(process.cwd(), 'assets', 'sfx'),
      ruisvloerDb: ruisvloer,
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
/**
 * Huisstijl van de campagne: accentkleur en font. De kleur komt eenmalig uit
 * de thumbnail; het font is instelbaar per campagne (archivo/bebas/inter) met
 * archivo als stevige standaard.
 */
async function bepaalHuisstijl(
  supabase: ReturnType<typeof db>,
  videoId: string,
  sourceUrl: string,
): Promise<Huisstijl> {
  const { data: v } = await supabase.from('videos').select('campaign_id').eq('id', videoId).single();
  if (!v?.campaign_id) return { font: 'archivo' };
  const { data: c } = await supabase.from('campaigns').select('huisstijl').eq('id', v.campaign_id).single();
  const bestaand = (c?.huisstijl as { accent?: string; font?: string } | null) ?? {};
  if (bestaand.accent) return { accent: bestaand.accent, font: bestaand.font ?? 'archivo' };

  const kleur = await kleurUitThumbnail(sourceUrl);
  if (kleur) {
    await supabase
      .from('campaigns')
      .update({ huisstijl: { ...bestaand, accent: kleur, bron: 'thumbnail' } })
      .eq('id', v.campaign_id);
    console.log(`  huisstijl bepaald uit thumbnail: ${kleur}`);
  }
  return { accent: kleur, font: bestaand.font ?? 'archivo' };
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
    type Meting = { x: number; breedte: number; personen: number; breed: boolean };
    const posities = JSON.parse(uit.trim() || '[]') as (Meting | null)[];
    if (posities.length === 0) return;

    let breedGeteld = 0;
    zonderScriptFocus.forEach((s, i) => {
      const m = posities[i];
      if (!m) return;
      s.focusX = m.x;
      // Twee mensen ver uit elkaar zonder duidelijke spreker: niet inzoomen en
      // niet strak kadreren, anders staat de uitsnede tussen twee hoofden in.
      if (m.breed) {
        s.breed = true;
        breedGeteld++;
      }
    });
    const gevonden = posities.filter((x) => x !== null).length;
    console.log(
      `     spreker in beeld: ${gevonden}/${posities.length} segmenten` +
        (breedGeteld ? `, ${breedGeteld}x meerdere personen (niet ingezoomd)` : ''),
    );
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
