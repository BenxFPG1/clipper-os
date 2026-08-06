import 'dotenv/config';
import { readFile, rm, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../src/lib/supabase';
import { requireEnv } from '../src/lib/env';
import { spawn, spawnSync } from 'node:child_process';
import { Shot, maakRuweMontage, detecteerStiltes, meetRuisvloer, bepaalSegmenten, zorgVoorBron, type BurnOverlay } from '../src/lib/roughcut';
import { maakTekstkaarten, tekenHookKaart, kleurUitThumbnail, kaartenMap, type Huisstijl } from '../src/lib/roughcut/tekstkaarten';
import { lijnShotsUit } from '../src/lib/roughcut/uitlijnen';
import { runEditAgent, beslissingenVoorClip } from '../src/lib/agents/edit';

import { zorgVoorMuziekbed } from '../src/lib/muziek';

import { kiesHuisstijl } from '../src/lib/agents/huisstijl';
import { controleerKaderVisueel } from '../src/lib/agents/kadercheck';
import {
  corrigeerKadrering,
  maakControlebeelden,
  pasVisueleCorrectieToe,
} from '../src/lib/roughcut/kadercontrole';
import { maakSpoor, type Kader } from '../src/lib/roughcut/kader';
import {
  beoordeelKnippen,
  controleerEindmontage,
  verschuifNaarPauze,
  zoekStilstePunt,
} from '../src/lib/roughcut/knipcontrole';
import { pakFrames } from '../src/lib/roughcut/frames';

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

  // Huisstijl pas hier: de agent kijkt naar frames uit de bron, en die staat nu
  // op schijf. Eerder zou hij de hele video een tweede keer downloaden.
  const stijl = await bepaalHuisstijl(supabase, job.video_id, video.source_url, bronPad);
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
    const { shots: uitgelijnd, uitgelijnd: aantalUitgelijnd, woordgrenzen } = await lijnShotsUit(
      bronPad,
      clip.shots,
      { log: (m) => console.log(`     ${m}`) },
    );
    const segmenten = bepaalSegmenten(uitgelijnd, {
      transcript: (videoRij?.transcript as never) ?? undefined,
      stiltes: stiltes ?? undefined,
      uitgelijnd: aantalUitgelijnd > 0,
      woordgrenzen,
    });

    // Gezichtsfocus per segment (alleen waar het script geen focus opgeeft).
    await vulGezichtsFocus(bronPad, segmenten);

    // Beweegt de spreker binnen een shot, of neemt de ander halverwege het
    // woord over? Dan de uitsnede laten meelopen in plaats van uitzoomen.
    const gevolgd = await meetSpoor(bronPad, segmenten);
    if (gevolgd > 0) console.log(`     ${gevolgd} shot(s) met meelopende uitsnede (face tracking)`);

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
      const hookTot = 2.6;
      // Twee kaarten tegelijk in beeld is één te veel: de hook ís de belofte
      // en moet die eerste seconden alleen staan. Kaarten die eronder zouden
      // vallen schuiven erachteraan, of vervallen als er niets van overblijft.
      for (let k = overlays.length - 1; k >= 0; k--) {
        if (overlays[k].start < hookTot) {
          if (overlays[k].end - hookTot < 0.7) overlays.splice(k, 1);
          else overlays[k] = { ...overlays[k], start: hookTot };
        }
      }
      overlays.unshift({ pad: hookPad, start: 0, end: hookTot });
    }

    // Kadercontrole in twee fases, met een lus eromheen. Fase 1 rekent uit wat
    // er werkelijk in beeld valt en corrigeert wat aantoonbaar fout is. Fase 2
    // laat de agent kijken naar precies het beeld dat de kijker straks ziet, en
    // stuurt bij wat je niet kunt uitrekenen: een uitsnede zonder mens erin,
    // een zichtbare split-screen-naad, een benauwd kader.
    {
      const kaderKeuze = (editClip?.kader ?? clip.kader ?? 'vullend') as Kader;
      const eerste = corrigeerKadrering(segmenten);
      for (const c of eerste) console.log(`     kadercontrole shot ${c.volgorde}: ${c.wat}`);

      const RONDES = Number(process.env.KADER_RONDES ?? 2);
      for (let ronde = 1; ronde <= RONDES; ronde++) {
        const beelden = await maakControlebeelden(bronPad, segmenten, kaartMap, kaderKeuze);
        if (beelden.length === 0) break;

        let oordeel;
        try {
          oordeel = await controleerKaderVisueel(beelden);
        } catch (e) {
          console.log(`     visuele kadercontrole overgeslagen (${(e as Error).message.slice(0, 70)})`);
          break;
        }

        const fout = oordeel.shots.filter((o) => !o.goed);
        if (fout.length === 0) {
          console.log(`     kadercontrole ronde ${ronde}: alle ${beelden.length} shots goed`);
          break;
        }

        let aangepast = 0;
        for (const o of fout) {
          const seg = segmenten.find((sg) => sg.volgorde === o.volgorde);
          if (!seg) continue;
          const wat = pasVisueleCorrectieToe(seg, o.correctie, o.sterkte);
          if (wat) aangepast++;
          // Ook loggen wat niet op te lossen viel: anders staat er straks een
          // klacht in de log zonder dat je weet waarover.
          console.log(
            `     ronde ${ronde} shot ${o.volgorde}: ${o.probleem.slice(0, 80)} → ${wat ?? `geen ingreep mogelijk (${o.correctie})`}`,
          );
        }

        // Niets meer kunnen bijstellen? Dan is doorgaan zinloos; nog een ronde
        // levert hetzelfde oordeel op en kost alleen tokens.
        if (aangepast === 0) {
          console.log(`     ronde ${ronde}: ${fout.length} klacht(en) niet oplosbaar met een kaderingreep`);
          break;
        }
        // Na het verschuiven opnieuw rekenkundig toetsen: een handmatige duw
        // mag het gezicht niet alsnog uit beeld schuiven.
        corrigeerKadrering(segmenten);
      }
    }

    // Knipcontrole: luisteren of elke knip werkelijk in een pauze valt, en
    // net zo lang naar buiten opschuiven tot dat zo is. Elke stap vóór deze
    // (uitlijning, dode lucht, in- en uitloop) kan het punt een fractie
    // verschuiven, en één fractie is genoeg om middenin een lettergreep te
    // eindigen. Meten is de enige harde toets.
    {
      const geprobeerd = new Map<string, number[]>();
      // De oorspronkelijke grenzen onthouden: het knippunt mag in totaal niet
      // verder dan anderhalve seconde opschuiven, hoeveel rondes we ook doen.
      const origineel = new Map(segmenten.map((sg) => [sg.volgorde, { start: sg.start, end: sg.end }]));
      for (let ronde = 1; ronde <= 2; ronde++) {
        const oordeel = await beoordeelKnippen(bronPad, segmenten);
        const fout = oordeel.filter((o) => !o.goed);
        if (fout.length === 0) {
          console.log(`     knipcontrole: alle ${oordeel.length} knippen in een pauze`);
          break;
        }

        let verzet = 0;
        for (const o of fout) {
          const seg = segmenten.find((sg) => sg.volgorde === o.volgorde);
          if (!seg) continue;
          const sleutel = `${o.volgorde}-${o.kant}`;
          const eerder = geprobeerd.get(sleutel) ?? [];
          const basis = origineel.get(o.volgorde);
          const anker = o.kant === 'begin' ? basis?.start ?? o.seconde : basis?.end ?? o.seconde;
          const ruimte = Math.max(0, 1.5 - Math.abs(o.seconde - anker));
          const nieuwPunt =
            ruimte < 0.05 ? null : verschuifNaarPauze(o.seconde, o.kant, stiltes ?? [], eerder, Math.min(1.2, ruimte));
          if (nieuwPunt === null) {
            // Geen echte pauze in de buurt. Dan alsnog het stilste moment in de
            // golfvorm zoeken: het dal tussen twee woorden klinkt hoorbaar beter
            // dan een knip midden op een klinker.
            const dal = await zoekStilstePunt(bronPad, o.seconde, o.kant);
            if (dal) {
              if (o.kant === 'begin') seg.start = dal.seconde;
              else seg.end = dal.seconde;
              verzet++;
              console.log(
                `     knip ${o.volgorde} ${o.kant}: geen pauze, wel een dal → ${dal.seconde.toFixed(2)}s (${dal.db} dB)`,
              );
              continue;
            }

            // Ook geen dal: dan blijft de knip staan, maar krijgt hij een
            // langere fade zodat hij niet als een afgebroken woord klinkt.
            if (o.kant === 'begin') seg.zachtBegin = true;
            else seg.zachtEind = true;
            console.log(
              `     knip ${o.volgorde} ${o.kant} blijft op ${o.seconde.toFixed(2)}s (${o.db} dB): geen pauze binnen de marge, zachte overgang`,
            );
            continue;
          }
          geprobeerd.set(sleutel, [...eerder, nieuwPunt]);
          if (o.kant === 'begin') seg.start = nieuwPunt;
          else seg.end = nieuwPunt;
          verzet++;
          console.log(
            `     knip ${o.volgorde} ${o.kant}: ${o.db} dB op ${o.seconde.toFixed(2)}s → ${nieuwPunt.toFixed(2)}s`,
          );
        }
        if (verzet === 0) break;
      }
    }

    // De uiteindelijke knippunten loggen. Zonder dit is achteraf niet na te
    // gaan of een knip midden in een woord viel of netjes in een pauze — en
    // dat was nu juist de hardnekkigste klacht.
    {
      let tijdlijn = 0;
      for (const sg of segmenten) {
        const lengte = sg.end - sg.start;
        console.log(
          `     knip ${sg.volgorde}: bron ${sg.start.toFixed(2)}-${sg.end.toFixed(2)}` +
            ` → tijdlijn ${tijdlijn.toFixed(2)}-${(tijdlijn + lengte).toFixed(2)}`,
        );
        tijdlijn += lengte;
      }
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
      muziekPad: await zorgVoorMuziekbed(editClip?.muziek ?? clip.muziek ?? 'geen', {
        werkmap: bronmap,
        seconden: segmenten.reduce((t, sg) => t + (sg.end - sg.start), 0),
        beschrijving: clip.titel_intern,
        log: (m) => console.log(`     ${m}`),
      }),
      sfxMap: join(process.cwd(), 'assets', 'sfx'),
      ruisvloerDb: ruisvloer,
      maxBytes: MAX_BYTES,
      onVoortgang: (m) => console.log(`     ${m}`),
    });

    // Sluitstuk: het gerenderde bestand zelf nameten. De controles hiervóór
    // kijken naar de bron; deze kijkt naar wat je daadwerkelijk krijgt. Blijkt
    // hier iets mis, dan zit de fout in de keten erna (fades, ducking) en niet
    // in de keuze van het knippunt.
    try {
      const eind = await controleerEindmontage(montage.pad, segmenten);
      if (eind.slecht.length === 0) {
        console.log(`     eindcontrole: alle ${eind.naden} naden schoon`);
      } else {
        for (const s of eind.slecht) {
          console.log(`     eindcontrole: naad op ${s.seconde.toFixed(2)}s meet ${s.db} dB (spraak)`);
        }
      }
    } catch (e) {
      console.log(`     eindcontrole overgeslagen (${(e as Error).message.slice(0, 60)})`);
    }

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
  bronBestand?: string,
): Promise<Huisstijl> {
  const { data: v } = await supabase.from('videos').select('campaign_id').eq('id', videoId).single();
  if (!v?.campaign_id) return { font: 'archivo' };
  const { data: c } = await supabase.from('campaigns').select('huisstijl').eq('id', v.campaign_id).single();
  const bestaand = (c?.huisstijl as { accent?: string; font?: string } | null) ?? {};
  // Al bepaald? Dan niet opnieuw: de huisstijl hoort over alle clips van een
  // campagne hetzelfde te zijn, en dit scheelt een call per render.
  if (bestaand.accent && bestaand.font) return { accent: bestaand.accent, font: bestaand.font };

  const kleur = bestaand.accent ?? (await kleurUitThumbnail(sourceUrl));

  // Laat de huisstijl-agent kijken naar het materiaal in plaats van alleen de
  // dominante kleur uit te rekenen. Het lettertype draagt minstens zoveel merk
  // als de kleur, en dat valt niet uit pixels te berekenen.
  let map: string | null = null;
  try {
    const { data: camp } = await supabase
      .from('campaigns')
      .select('name, briefing')
      .eq('id', v.campaign_id)
      .single();

    const frames = await pakFrames(sourceUrl, { maxFrames: 4, bronBestand });
    map = frames.map;
    if (frames.frames.length > 0) {
      const keuze = await kiesHuisstijl({
        campagneNaam: (camp?.name as string) ?? 'onbekend',
        briefing: (camp?.briefing as string | null) ?? null,
        beeldPaden: frames.frames.map((f) => f.pad),
        gemetenAccent: kleur,
      });
      await supabase
        .from('campaigns')
        .update({ huisstijl: { accent: keuze.accent, font: keuze.font, bron: 'gezien', waarom: keuze.waarom } })
        .eq('id', v.campaign_id);
      console.log(`  huisstijl gezien: ${keuze.accent} + ${keuze.font} — ${keuze.waarom}`);
      return { accent: keuze.accent, font: keuze.font };
    }
  } catch (e) {
    console.log(`  huisstijl-agent niet gelukt (${(e as Error).message.slice(0, 90)}); kleur uit thumbnail`);
  } finally {
    if (map) await rm(map, { recursive: true, force: true });
  }

  if (kleur) {
    await supabase
      .from('campaigns')
      .update({ huisstijl: { ...bestaand, accent: kleur, bron: 'thumbnail' } })
      .eq('id', v.campaign_id);
  }
  return { accent: kleur, font: bestaand.font ?? 'archivo' };
}

/**
 * Welke python heeft OpenCV én numpy? Op een machine met meerdere
 * installaties wees `python3` niet per se naar dezelfde als waar pip in
 * installeerde, en dan viel de sprekerdetectie stil terug op het midden zonder
 * dat iemand het merkte.
 */
let pythonKeuze: { cmd: string; voor: string[] } | null = null;
function pythonMetOpenCV(): { cmd: string; voor: string[] } {
  if (pythonKeuze) return pythonKeuze;

  const binaries = [process.env.PYTHON_BIN, 'python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3', 'python']
    .filter(Boolean) as string[];

  const kandidaten: { cmd: string; voor: string[] }[] = [];
  for (const bin of binaries) {
    kandidaten.push({ cmd: bin, voor: [] });
    // Draait Node onder Rosetta (x86_64) op een Apple Silicon-Mac, dan erft de
    // python die hij start diezelfde architectuur en weigert numpy te laden —
    // dat is arm64. `arch -arm64` zet dat recht. Op andere machines bestaat het
    // commando niet of faalt de proef, en dan valt hij gewoon door.
    if (process.platform === 'darwin') kandidaten.push({ cmd: 'arch', voor: ['-arm64', bin] });
  }

  for (const kandidaat of kandidaten) {
    const proef = spawnSync(kandidaat.cmd, [...kandidaat.voor, '-c', 'import cv2, numpy'], { stdio: 'ignore' });
    if (proef.status === 0) {
      pythonKeuze = kandidaat;
      return kandidaat;
    }
  }
  pythonKeuze = { cmd: 'python3', voor: [] };
  return pythonKeuze;
}

/**
 * Meet fijnmazig waar de spreker staat gedurende een shot, zodat de uitsnede
 * hem kan volgen in plaats van uit te zoomen tot alle uitersten passen.
 *
 * Alleen voor shots waar het nodig is: het kost een meting per driekwart
 * seconde, en op een statische talking head verandert er toch niets.
 */
async function meetSpoor(bronPad: string, segmenten: Shot[]): Promise<number> {
  const teVolgen = segmenten.filter((s) => (s.spreiding ?? 0) > 0.08);
  if (teVolgen.length === 0) return 0;

  const STAP = 0.75;
  const opdrachten: { seg: Shot; tijden: number[] }[] = teVolgen.map((seg) => {
    const tijden: number[] = [];
    for (let t = seg.start; t < seg.end; t += STAP) tijden.push(t);
    tijden.push(seg.end - 0.05);
    return { seg, tijden };
  });

  const alle = opdrachten.flatMap((o) => o.tijden);
  let posities: ({ x: number } | null)[] = [];
  try {
    const py = pythonMetOpenCV();
    const uit = await new Promise<string>((klaar, fout) => {
      // Eén frame per meetpunt: we willen hier fijnmazigheid, geen robuustheid
      // per punt — het gladstrijken daarna vangt de uitschieters op.
      const kind = spawn(py.cmd, [...py.voor, 'scripts/gezichten.py', bronPad, JSON.stringify(alle), '1']);
      let stdout = '';
      let stderr = '';
      kind.stdout.on('data', (d) => (stdout += d));
      kind.stderr.on('data', (d) => (stderr += d));
      kind.on('error', fout);
      kind.on('close', (code) => (code === 0 ? klaar(stdout) : fout(new Error(stderr.slice(-120)))));
    });
    posities = JSON.parse(uit.trim() || '[]');
  } catch {
    return 0;
  }
  if (posities.length !== alle.length) return 0;

  let index = 0;
  let gevolgd = 0;
  for (const { seg, tijden } of opdrachten) {
    const metingen = tijden.map((t, i) => ({
      t: t - seg.start,
      x: posities[index + i]?.x ?? null,
    }));
    index += tijden.length;
    if (metingen.filter((m) => m.x !== null).length < 2) continue;
    seg.spoor = maakSpoor(metingen);
    gevolgd++;
  }
  return gevolgd;
}

/**
 * Meet per segment waar de spreker staat en zet dat als focusX,
 * zodat de verticale uitsnede de spreker volgt in plaats van blind het midden
 * te pakken. Draait via OpenCV (python); ontbreekt dat, dan blijft het midden.
 */
async function vulGezichtsFocus(bronPad: string, segmenten: Shot[]): Promise<void> {
  // Alle segmenten meten, ook die waar het plan al een focus opgaf: de meting
  // is betrouwbaarder dan de gok van een agent die de beelden niet ziet.
  const zonderScriptFocus = segmenten;
  if (zonderScriptFocus.length === 0) return;

  // Drie momenten per shot in plaats van alleen het midden. Een shot van tien
  // seconden verandert onderweg: de camera wisselt, iemand leunt weg, of het
  // split screen springt om. Eén meting op het midden gaf dan een kadrering die
  // de rest van het shot nergens op sloeg — letterlijk een uitsnede van de
  // boekenkast.
  const MOMENTEN = [0.25, 0.5, 0.75];
  const tijden = zonderScriptFocus.flatMap((s) =>
    MOMENTEN.map((f) => s.start + (s.end - s.start) * f),
  );
  try {
    const uit = await new Promise<string>((klaar, fout) => {
      const py = pythonMetOpenCV();
      const kind = spawn(py.cmd, [...py.voor, 'scripts/gezichten.py', bronPad, JSON.stringify(tijden)]);
      let stdout = '';
      let stderr = '';
      kind.stdout.on('data', (d) => (stdout += d));
      kind.stderr.on('data', (d) => (stderr += d));
      kind.on('error', fout);
      kind.on('close', (code) => (code === 0 ? klaar(stdout) : fout(new Error(stderr.slice(-150)))));
    });
    type Meting = {
      x: number;
      breedte: number;
      personen: number;
      breed: boolean;
      paneel: [number, number] | null;
      top: number;
      hoogte: number;
    };
    // OpenCV schrijft zelf ook naar stdout (waarschuwingen over bindings), dus
    // niet blind de hele uitvoer parsen: pak de laatste regel die JSON is.
    const regel = uit
      .split('\n')
      .map((r) => r.trim())
      .reverse()
      .find((r) => r.startsWith('['));
    const posities = JSON.parse(regel || '[]') as (Meting | null)[];
    if (posities.length === 0) {
      console.log(`     LET OP: sprekerdetectie leverde niets op (${uit.trim().slice(0, 100)})`);
      return;
    }

    let breedGeteld = 0;
    zonderScriptFocus.forEach((s, i) => {
      const groep = posities.slice(i * MOMENTEN.length, (i + 1) * MOMENTEN.length).filter(Boolean) as Meting[];
      if (groep.length === 0) return;

      const xs = groep.map((m) => m.x).sort((a, b) => a - b);
      s.focusX = xs[Math.floor(xs.length / 2)];
      const ws = groep.map((m) => m.breedte).sort((a, b) => a - b);
      s.focusW = ws[Math.floor(ws.length / 2)];

      // Het volledige gezichtsvak bewaren: daar toetst de kadercontrole tegen.
      const tops = groep.map((m) => m.top).sort((a, b) => a - b);
      const hs = groep.map((m) => m.hoogte).sort((a, b) => a - b);
      s.gezicht = {
        x: s.focusX,
        breedte: s.focusW,
        top: tops[Math.floor(tops.length / 2)],
        hoogte: hs[Math.floor(hs.length / 2)],
      };

      // Hoe ver beweegt de spreker binnen dit shot? Dat begrenst straks de
      // zoom: precies genoeg om hem de hele tijd in beeld te houden, in plaats
      // van uit voorzorg helemaal niet inzoomen.
      //
      // Niet het verschil tussen de uiterste metingen nemen: pakt de detectie op
      // één van de drie momenten de gesprekspartner in plaats van de spreker,
      // dan lijkt hij een halve beeldbreedte te verspringen en zoomen we
      // helemaal niet meer in. Daarom eerst de uitschieters eruit, en dan pas de
      // spreiding van wat overblijft.
      const mediaan = s.focusX;
      const dichtbij = xs.filter((x) => Math.abs(x - mediaan) <= 0.2);
      const kern = dichtbij.length >= 2 ? dichtbij : xs;
      s.spreiding = kern[kern.length - 1] - kern[0];
      if (s.spreiding > 0.15) breedGeteld++;

      // Alleen binnen een paneel kadreren als alle metingen het eens zijn; is
      // het beeld halverwege omgesprongen, dan klopt de uitsnede maar de helft
      // van de tijd.
      const panelen = groep.map((m) => (m.paneel ? m.paneel.join(',') : ''));
      if (panelen[0] && panelen.every((p) => p === panelen[0])) {
        s.paneel = groep[0].paneel ?? undefined;
      }
      // Meerdere mensen in beeld is geen reden om niet in te zoomen — de
      // sprekerdetectie wijst inmiddels betrouwbaar de juiste persoon aan. Wel
      // reden om de spreiding mee te wegen, en dat gebeurt hierboven al.
    });
    const gevonden = zonderScriptFocus.filter((s) => typeof s.focusX === 'number').length;
    const panelen = zonderScriptFocus.filter((s) => s.paneel).length;
    console.log(
      `     spreker in beeld: ${gevonden}/${zonderScriptFocus.length} segmenten` +
        (breedGeteld ? `, ${breedGeteld}x zoom begrensd omdat de spreker beweegt` : '') +
        (panelen ? `, ${panelen}x split screen in de bron (binnen het paneel gekadreerd)` : ''),
    );
  } catch (e) {
    // Geen OpenCV of geen leesbare video. Dat is geen ramp — het midden is de
    // terugval — maar het moet wél zichtbaar zijn: de detectie faalde eerder
    // maandenlang stil, en dan kadreert de hele tool blind.
    console.log(`     LET OP: sprekerdetectie mislukt (${(e as Error).message.slice(0, 120)})`);
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
