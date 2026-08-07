import 'dotenv/config';
import { readFile, rm, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../src/lib/supabase';
import { requireEnv } from '../src/lib/env';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
import { controleerScript } from '../src/lib/roughcut/scriptcontrole';
import { haalBronWoorden, vindFragment } from '../src/lib/roughcut/woorden';
import { poort } from '../src/lib/roughcut/poort';
import { keurMontage } from '../src/lib/roughcut/keuring';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { pythonMetOpenCV } from '../src/lib/python';
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
  const bestanden: {
    naam: string;
    pad: string;
    bytes: number;
    keuring?: { goed: boolean; regels: { naam: string; goed: boolean; detail: string }[] } | null;
  }[] = [...alGedaan];

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
  // De brontranscriptie is de enige waarheid voor knipgrenzen. Eenmalig per
  // video, daarna uit de cache.
  const bronWoorden = await haalBronWoorden(job.video_id, bronPad, {
    log: (m) => console.log(`  ${m}`),
  });

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

    // De grenzen komen uit de brontranscriptie: elk fragment wordt in de
    // volledige tekst opgezocht en de knip valt exact tussen het laatste woord
    // ervóór en het eerste woord van het fragment. Geen venstertjes, geen
    // snappen, geen raden. Alleen als een fragment niet te vinden is, valt dat
    // shot terug op de oude venster-uitlijning.
    let uitgelijnd: typeof clip.shots;
    let aantalUitgelijnd = 0;
    let woordgrenzen: number[] = [];
    if (bronWoorden) {
      const geankerd: string[] = [];
      uitgelijnd = clip.shots.map((shot) => {
        const fragment = (shot as { transcript_fragment?: string }).transcript_fragment;
        if (!fragment || fragment.length < 12) {
          return { ...shot, planStart: shot.start, planEnd: shot.end };
        }
        const anker = vindFragment(bronWoorden, fragment, shot.start);
        if (!anker) {
          geankerd.push(`${shot.volgorde}✗`);
          return { ...shot, planStart: shot.start, planEnd: shot.end };
        }
        aantalUitgelijnd++;
        geankerd.push(
          `${shot.volgorde}@${anker.start !== null ? anker.start.toFixed(1) : 'plan'}` +
            `${anker.end === null ? '→plan' : ''}(${Math.round(anker.score * 100)}%)`,
        );
        // Per kant: alleen een geankerde kant is exact; een onzekere kant
        // houdt de planwaarde en de gewone controles. "exact" (en dus het
        // overslaan van snap en knipcontrole) geldt alleen als béide kanten
        // op woorden staan.
        const beideZeker = anker.start !== null && anker.end !== null;
        return {
          ...shot,
          // De helft van de ruimte tot het buurwoord als adem, met een kleine
          // boven- en ondergrens. Sluit het woord vrijwel direct aan, dan een
          // zachte fade in plaats van een hoorbare knip.
          start:
            anker.start !== null
              ? Math.max(0, anker.start - Math.min(0.3, Math.max(0.04, anker.gapVoor / 2)))
              : shot.start,
          end: anker.end !== null ? anker.end + Math.min(0.45, Math.max(0.08, anker.gapNa / 2)) : shot.end,
          exact: beideZeker,
          zachtBegin: anker.start !== null && anker.gapVoor < 0.18,
          zachtEind: anker.end !== null && anker.gapNa < 0.18,
          planStart: shot.start,
          planEnd: shot.end,
        };
      });
      console.log(`     woordanker: ${geankerd.join(' ')}`);
    } else {
      const uitlijning = await lijnShotsUit(bronPad, clip.shots, {
        log: (m) => console.log(`     ${m}`),
      });
      uitgelijnd = uitlijning.shots as typeof clip.shots;
      aantalUitgelijnd = uitlijning.uitgelijnd;
      woordgrenzen = uitlijning.woordgrenzen;
    }
    const segmenten = bepaalSegmenten(uitgelijnd, {
      transcript: (videoRij?.transcript as never) ?? undefined,
      stiltes: stiltes ?? undefined,
      uitgelijnd: aantalUitgelijnd > 0,
      woordgrenzen,
    });

    // Een halve zin twee keer horen komt hiervandaan: de planner zette de hook
    // en de payoff op hetzelfde bronfragment (cold open), en dan hoort de
    // kijker dezelfde zin twee keer. Dat mag niet — de regel is: geen enkele
    // zin klinkt dubbel in een clip.
    //
    // Is het duplicaat vrijwel volledig én staat de belofte al als hooktekst
    // in beeld, dan vervalt het audioduplicaat helemaal: de tekstkaart draagt
    // de hook, de zin klinkt één keer, op zijn plek in het verhaal. In andere
    // gevallen wordt de eerste versie ingekort tot een korte tease die op een
    // pauze eindigt. HOOK_TEASE=1 dwingt altijd de tease-variant af.
    for (let i = segmenten.length - 1; i >= 0; i--) {
      for (let j = i + 1; j < segmenten.length; j++) {
        const a = segmenten[i];
        const b = segmenten[j];
        if (!a || !b) continue;
        const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
        const kortste = Math.min(a.end - a.start, b.end - b.start);
        if (overlap <= kortste * 0.5) continue;

        const bijnaDuplicaat = overlap >= (b.end - b.start) * 0.8;
        // De hook helemaal schrappen bleek te ver: dan opent de clip op de
        // setup en voelt de structuur niet meer als het script. Standaard wordt
        // het duplicaat dus een kórte tease die op een pauze eindigt — hook
        // aanwezig, zonder dat de volle zin twee keer klinkt. HOOK_WEG=1
        // schrapt hem alsnog helemaal.
        if (bijnaDuplicaat && clip.hook?.tekst_overlay && process.env.HOOK_WEG === '1') {
          console.log(
            `     herhaling: shot ${a.volgorde} is een duplicaat van shot ${b.volgorde}; ` +
              `audio-hook vervalt, de hooktekst in beeld draagt de belofte`,
          );
          segmenten.splice(i, 1);
          break;
        }

        // De cold open mag blijven, maar nooit als halve zin. Eerdere pogingen
        // gebruikten de interpunctie van de transcriptie als zinseinde, en die
        // zet punten waar de spreker doorpraat. De woordtijden zijn wél
        // betrouwbaar: een gat van 0,35s of meer tussen twee woorden is een
        // echte adempauze, en dáár mag de tease eindigen. Vinden we er geen
        // binnen een korte hook, dan vervalt de audio-hook en draagt de
        // hooktekst in beeld de belofte.
        const isOntworpenTease = a.end - a.start <= 4.5;
        if (isOntworpenTease) {
          (a as { tease?: boolean }).tease = true;
          continue;
        }

        // Waar mag de cold open eindigen? Bij voorkeur op een adempauze, maar
        // die zijn zeldzaam: deze spreker praat zonder gaten door (gemeten:
        // vrijwel elk gat is 0,00s). Een zin die eindigt op een punt en
        // gevolgd wordt door een hoofdletter is dan de beste beschikbare
        // grens — de tease stopt op een afgeronde gedachte, niet middenin.
        let teaseEind: number | null = null;
        if (bronWoorden) {
          const grens = a.start + 5.5;
          let opPauze: number | null = null;
          let opZin: number | null = null;
          for (let k = 1; k < bronWoorden.length; k++) {
            const vorig = bronWoorden[k - 1];
            const nu = bronWoorden[k];
            if (vorig.e <= a.start + 1.2 || vorig.e > grens) continue;
            if (opPauze === null && nu.s - vorig.e >= 0.3) opPauze = vorig.e;
            // Punt én een hoofdletter erna: twee signalen die samen betrouwbaar
            // genoeg zijn voor een afgeronde gedachte. Een gat eisen kan niet —
            // deze spreker heeft er geen.
            if (opZin === null && /[.!?]$/.test(vorig.w.trim()) && /^[A-ZÀ-Ý]/.test(nu.w.trim())) {
              opZin = vorig.e;
            }
          }
          teaseEind = opPauze ?? opZin;
        }

        if (teaseEind !== null) {
          console.log(
            `     herhaling: shot ${a.volgorde} en ${b.volgorde} delen ${overlap.toFixed(1)}s bron; ` +
              `cold open eindigt op een gemeten adempauze na ${(teaseEind - a.start).toFixed(1)}s`,
          );
          a.end = teaseEind + 0.1;
          (a as { tease?: boolean }).tease = true;
          continue;
        }

        console.log(
          `     herhaling: shot ${a.volgorde} dupliceert shot ${b.volgorde} en heeft geen adempauze ` +
            `binnen de cold open; audio-hook vervalt, de hooktekst draagt de belofte`,
        );
        segmenten.splice(i, 1);
        break;
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
          // Woordanker-grenzen staan al exact op het woord; als het daar niet
          // stil is, praat de spreker gewoon door en is een zachte fade het
          // juiste antwoord — verschuiven maakt het alleen maar fout.
          if (seg.exact) {
            if (o.kant === 'begin') seg.zachtBegin = true;
            else seg.zachtEind = true;
            continue;
          }
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

    // Harde regel, ná alle verschuivingen: geen twee segmenten in één clip
    // delen bronmateriaal. De knipcontrole en de uitlijning mogen grenzen
    // oprekken, maar zodra shot A tot ín het bereik van shot B loopt, hoort de
    // kijker diezelfde woorden twee keer. De eerdere versie levert in — de
    // latere zit op zijn plek in het verhaal en blijft heel.
    for (let i = 0; i < segmenten.length; i++) {
      for (let j = 0; j < segmenten.length; j++) {
        if (i === j) continue;
        const a = segmenten[i];
        const b = segmenten[j];
        const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
        if (overlap <= 0.15) continue;
        // Alleen de variant afknippen waar dat kan zonder het segment te slopen.
        if (a.end > b.start && a.start < b.start && b.start - a.start >= 0.8) {
          console.log(
            `     overlap: shot ${a.volgorde} liep ${overlap.toFixed(1)}s in shot ${b.volgorde}; eind terug naar ${b.start.toFixed(2)}s`,
          );
          a.end = b.start;
        }
      }
    }


    // Gezichtsfocus per segment (alleen waar het script geen focus opgeeft).
    await vulGezichtsFocus(bronPad, segmenten);

    // Beweegt de spreker binnen een shot, of neemt de ander halverwege het
    // woord over? Dan de uitsnede laten meelopen in plaats van uitzoomen.
    const gevolgd = await meetSpoor(bronPad, segmenten);
    if (gevolgd > 0) console.log(`     ${gevolgd} shot(s) met meelopende uitsnede (face tracking)`);

    // Regel: een sprekerswissel is een knip, geen pan. Neemt de ander het woord
    // over, dan ligt er een halve beeldbreedte tussen de twee posities en pant
    // een meelopende uitsnede seconden door leeg midden — niemand in beeld.
    // Dus: springt het spoor blijvend, dan splitsen we het shot op het
    // wisselmoment in twee statische kaders. De audio loopt naadloos door; het
    // beeld wisselt naar de nieuwe spreker, precies zoals de editcraft-vault
    // het voorschrijft ("wissel naar de reactie").
    {
      const mediaan = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      for (let i = segmenten.length - 1; i >= 0; i--) {
        const seg = segmenten[i];
        const spoor = seg.spoor;
        if (!spoor || spoor.length < 4) continue;

        const kwart = Math.max(1, Math.floor(spoor.length / 3));
        const voor = mediaan(spoor.slice(0, kwart).map((punt) => punt.x));
        const na = mediaan(spoor.slice(-kwart).map((punt) => punt.x));
        if (Math.abs(na - voor) < 0.22) continue;
        // Alleen een échte sprong is een wissel; een glijdende verplaatsing is
        // dezelfde spreker die beweegt, en die wordt gevolgd — splitsen gaf
        // daar een tweede kader op verouderde meetdata.
        if ((seg.maxStap ?? 0) < 0.22) continue;

        // Het wisselmoment: waar het spoor het midden tussen beide posities
        // kruist.
        const midden = (voor + na) / 2;
        const kruising = spoor.find((punt) =>
          voor < na ? punt.x >= midden : punt.x <= midden,
        );
        const wissel = kruising?.t ?? (seg.start + seg.end) / 2;
        if (wissel - seg.start < 0.7 || seg.end - wissel < 0.7) continue;

        console.log(
          `     sprekerswissel in shot ${seg.volgorde} op ${wissel.toFixed(2)}s: pan vervangen door knip`,
        );
        const tweede: Shot = {
          ...seg,
          volgorde: seg.volgorde + 0.5,
          start: wissel,
          focusX: na,
          spoor: undefined,
          spreiding: 0,
          gezicht: seg.gezicht ? { ...seg.gezicht, x: na } : undefined,
          zachtBegin: false,
        };
        (tweede as { subKnip?: boolean }).subKnip = true;
        seg.end = wissel;
        seg.focusX = voor;
        seg.spoor = undefined;
        seg.spreiding = 0;
        seg.zachtEind = false;
        if (seg.gezicht) seg.gezicht = { ...seg.gezicht, x: voor };
        segmenten.splice(i + 1, 0, tweede);
      }
    }

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

    // Kaarten en hook als functie: de aanloopcorrectie verderop kan het eerste
    // segment inkorten, en dan moeten alle kaartposities opnieuw berekend
    // worden. Subsegmenten (uit de dode-luchtsplitsing) krijgen geen eigen
    // kaart, anders staat dezelfde kaart er twee keer.
    const bouwOverlays = async (): Promise<BurnOverlay[]> => {
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
    return overlays;
    };

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

    // DE POORT. Alles hierboven mag van alles vinden; wat hier uitkomt voldoet
    // aan de harde regels of wordt teruggeduwd. Er is geen weg naar de
    // renderer omheen — en grijpt hij ergens in, dan staat er een bug
    // bovenstrooms die je in dit rapport terugvindt.
    {
      const uitkomst = poort(segmenten, bronWoorden);
      for (const ing of uitkomst.ingrepen) {
        console.log(`     POORT shot ${ing.volgorde} [${ing.regel}]: ${ing.wat}`);
      }
      if (uitkomst.segmenten.length !== segmenten.length) {
        segmenten.length = 0;
        segmenten.push(...uitkomst.segmenten);
      }
      if (uitkomst.ingrepen.length === 0) console.log('     poort: alle regels gehaald zonder ingreep');

      // Vastleggen wat er uit de poort komt. Renderen is vanaf hier alleen nog
      // uitvoeren: hetzelfde montageplan geeft hetzelfde bestand. Daarmee kan
      // een clip die goed is ook goed blíjven — en kan de evaluatieset later
      // exact deze grenzen keuren in plaats van ze opnieuw te raden.
      try {
        const { data: rij } = await supabase
          .from('clip_plans')
          .select('id, montageplan')
          .eq('video_id', job.video_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        const bestaandPlan = (rij?.montageplan as { clips?: Record<string, unknown> } | null) ?? {};
        await supabase
          .from('clip_plans')
          .update({
            montageplan: {
              ...bestaandPlan,
              clips: {
                ...(bestaandPlan.clips ?? {}),
                [String(nummer)]: {
                  vastgelegd_at: new Date().toISOString(),
                  segmenten: segmenten.map((sg) => ({
                    volgorde: sg.volgorde,
                    start: sg.start,
                    end: sg.end,
                    functie: sg.functie,
                    focusX: sg.focusX,
                    focusY: sg.focusY,
                    zoom: sg.zoom,
                    paneel: sg.paneel,
                    spoor: sg.spoor,
                    spoorY: sg.spoorY,
                    transcript_fragment: (sg as { transcript_fragment?: string }).transcript_fragment,
                  })),
                },
              },
            },
          })
          .eq('id', rij!.id);
      } catch (e) {
        console.log(`     montageplan niet vastgelegd (${(e as Error).message.slice(0, 60)})`);
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

    let montage!: Awaited<ReturnType<typeof maakRuweMontage>>;
    let beeldRondeGedaan = false;
    let keuringsuitslag: Awaited<ReturnType<typeof keurMontage>> | null = null;
    for (let poging = 1; poging <= 4; poging++) {
    montage = await maakRuweMontage({
      sourceUrl: video.source_url,
      shots: segmenten,
      alGesegmenteerd: true,
      outputPad: lokaal,
      werkmap: bronmap,
      kader: editClip?.kader ?? clip.kader ?? 'vullend',
      overlays: await bouwOverlays(),
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

    // Zegt de clip wat het script voorschrijft? Het eindbestand wordt
    // terugvertaald naar tekst en vergeleken: dekking van de scriptwoorden, en
    // zinnen die twee keer klinken. Dit is de enige controle die een dubbele
    // zin of een verdwaald fragment kán zien — tijdcodes en geluidsniveaus
    // weten daar niets van.
    try {
      const script = await controleerScript(montage.pad, segmenten as never);
      if (script) {
        // Begint de clip niet op de scripttekst, dan is er bronmateriaal vóór
        // de eerste zin meegekomen (een los "Ja,", de staart van de vorige
        // vraag). Dat is alleen betrouwbaar te horen in het eindbestand — dus
        // corrigeren we het beginpunt en renderen we één keer opnieuw.
        const eerste = segmenten[0];
        if (script.aanloop && poging === 1 && eerste && eerste.end - eerste.start - script.aanloop.seconden > 1) {
          console.log(
            `     scriptcontrole: clip begint met "${script.aanloop.tekst}" (${script.aanloop.seconden}s vóór het script); beginpunt gecorrigeerd, opnieuw renderen`,
          );
          // Een minder strakke marge dan je zou willen: de woordtijden van het
          // transcriptiemodel zitten er zomaar drie tienden naast, en te strak
          // corrigeren sneed het eerste scriptwoord aan. Een restje aanloop
          // valt onder de zachte fade; een half eerste woord hoor je altijd.
          eerste.start += Math.max(0, script.aanloop.seconden - 0.45);
          eerste.zachtBegin = true;
          // De grens is verschoven, dus alle metingen van dit segment zijn
          // ongeldig — ook het spoor, anders volgt de camera het oude tijdvak.
          eerste.gezicht = undefined;
          eerste.spoor = undefined;
          await vulGezichtsFocus(bronPad, [eerste]);
          await meetSpoor(bronPad, [eerste]);
          corrigeerKadrering([eerste]);
          continue;
        }

        // Fragmenten waarvan de kop nergens klinkt zijn middenin de zin
        // aangesneden (de uitlijning heeft de verkeerde plek gepakt). Het plan
        // weet waar de zin echt begint — daar grijpen we op terug, één keer.
        const zoek = (script.perShot ?? []).filter((ps) => !ps.gevonden);
        if (zoek.length > 0 && poging <= 3) {
          let hersteld = 0;
          for (const ps of zoek) {
            const seg = segmenten.find((sg) => sg.volgorde === ps.volgorde);
            if (!seg || seg.planStart === undefined) continue;
            if (seg.start > seg.planStart + 0.3) {
              // De uitlijning zat later dan het plan: terug naar het plan.
              console.log(
                `     scriptcontrole shot ${ps.volgorde}: fragmentbegin niet terug te horen; start terug van ${seg.start.toFixed(2)} naar plan ${seg.planStart.toFixed(2)}`,
              );
              seg.start = Math.max(0, seg.planStart - 0.1);
            } else {
              // We staan al op het plan en de kop is alsnog niet terug te
              // horen. Vroeger stapte hij hier blind 1,5s terug — dat was een
              // gok, en gokken maakten goede knippen kapot (een start midden
              // in de vorige zin, kadrering die niet meer klopte). Met de
              // betere transcriptie is dit vrijwel altijd een verhaspeld woord
              // in de verificatie zelf. Dus: melden, niets verschuiven.
              console.log(
                `     scriptcontrole shot ${ps.volgorde}: kop niet herkend in de terugluistering (waarschijnlijk verhaspeld); grens blijft staan`,
              );
              continue;
            }
            seg.zachtBegin = true;
            // Grens verschoven: alle metingen van dit segment zijn ongeldig.
            // Volledig opnieuw meten — ook het spoor, anders volgt de camera
            // een positie uit het oude tijdvak.
            seg.gezicht = undefined;
            seg.spoor = undefined;
            await vulGezichtsFocus(bronPad, [seg]);
            await meetSpoor(bronPad, [seg]);
            corrigeerKadrering([seg]);
            hersteld++;
          }
          if (hersteld > 0) continue;
        }

        const procent = Math.round(script.dekking * 100);
        // De cold open herhaalt per definitie de payoff — dat is opzet, geen
        // fout. Alleen herhalingen die níet in de tease beginnen tellen.
        const teaseGrens = (segmenten[0] as { tease?: boolean }).tease
          ? segmenten[0].end - segmenten[0].start + 0.5
          : 0;
        const echteHerhalingen = script.herhalingen.filter((h) => h.eerste > teaseGrens);
        if (echteHerhalingen.length === 0 && procent >= 55) {
          const perShot = (script.perShot ?? [])
            .map((ps) => `${ps.volgorde}${ps.gevonden ? `✓@${ps.opSeconde}s` : '✗'}`)
            .join(' ');
          console.log(
            `     scriptcontrole: ${procent}% terug te horen, geen herhaalde zinnen | shots: ${perShot}`,
          );
        } else {
          if (procent < 55) console.log(`     scriptcontrole: maar ${procent}% van het script terug te horen`);
          for (const h of echteHerhalingen) {
            console.log(
              `     scriptcontrole: "${h.tekst}" klinkt twee keer (${h.eerste}s en ${h.tweede}s)`,
            );
          }
          if (echteHerhalingen.length < script.herhalingen.length) {
            console.log('     scriptcontrole: cold open herhaalt de payoff (bedoeld)');
          }
        }
      }
    } catch (e) {
      console.log(`     scriptcontrole overgeslagen (${(e as Error).message.slice(0, 60)})`);
    }
    // Beeldcontrole op het eindbestand zelf: frames uit de gerenderde clip,
    // niet uit een benadering. De controle vóór de render toetst wat er zou
    // móeten gebeuren; deze toetst wat er gebeurd ís — inclusief tracking,
    // paneel en zoom zoals ffmpeg ze werkelijk uitvoerde. Fouten worden
    // gecorrigeerd en één keer opnieuw gerenderd.
    if (!beeldRondeGedaan && process.env.KADER_RONDES !== '0') {
      beeldRondeGedaan = true;
      try {
        const beelden: { volgorde: number; pad: string }[] = [];
        let cursor = 0;
        for (const sg of segmenten) {
          const duurSeg = sg.end - sg.start;
          // Een statisch shot is met één beeld te beoordelen; bij een bewegende
          // spreker of een meelopende uitsnede kan het begin goed staan en het
          // eind niet — dan drie momenten.
          const beweegt = Boolean(sg.spoor?.length) || (sg.spreiding ?? 0) > 0.08;
          const punten = beweegt ? [0.2, 0.5, 0.85] : [0.5];
          for (const [k, fractie] of punten.entries()) {
            const beeldPad = join(kaartMap, `eind-${String(sg.volgorde).padStart(4, '0')}-${k}.jpg`);
            await new Promise<void>((klaar) => {
              const kind = spawn(resolveBinary('ffmpeg'), [
                '-nostdin', '-y', '-ss', (cursor + duurSeg * fractie).toFixed(2), '-i', montage.pad,
                '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', beeldPad,
              ], { stdio: ['ignore', 'ignore', 'ignore'] });
              kind.on('error', () => klaar());
              kind.on('close', () => klaar());
            });
            if (existsSync(beeldPad)) beelden.push({ volgorde: sg.volgorde, pad: beeldPad });
          }
          cursor += duurSeg;
        }

        const oordeel = await controleerKaderVisueel(beelden);
        const fout = oordeel.shots.filter((o) => !o.goed);
        if (fout.length === 0) {
          console.log(`     eindbeeldcontrole: alle ${beelden.length} shots goed in het eindbestand`);
        } else {
          let aangepast = 0;
          const alGecorrigeerd = new Set<number>();
          for (const o of fout) {
            const seg = segmenten.find((sg) => sg.volgorde === o.volgorde);
            if (!seg || alGecorrigeerd.has(o.volgorde)) continue;
            alGecorrigeerd.add(o.volgorde);
            const wat = pasVisueleCorrectieToe(seg, o.correctie, o.sterkte);
            if (wat) aangepast++;
            console.log(
              `     eindbeeldcontrole shot ${o.volgorde}: ${o.probleem.slice(0, 80)} → ${wat ?? 'geen ingreep mogelijk'}`,
            );
          }
          if (aangepast > 0 && poging < 4) {
            corrigeerKadrering(segmenten);
            console.log('     eindbeeldcontrole: correcties toegepast, opnieuw renderen');
            continue;
          }
        }
      } catch (e) {
        console.log(`     eindbeeldcontrole overgeslagen (${(e as Error).message.slice(0, 60)})`);
      }
    }

    break;
    }

    // De keuring: het eindoordeel over precies datgene waarop geoordeeld
    // wordt. Zelfde meting als de evaluatieset gebruikt, zodat "groen bij mij"
    // en "groen bij jou" hetzelfde betekenen.
    try {
      const rapport = await keurMontage(montage.pad, segmenten, bronWoorden, {
        python: pythonMetOpenCV(),
      });
      console.log(`     ── keuring: ${rapport.goed ? 'GOED' : 'NIET GOED'}`);
      for (const r of rapport.regels) {
        console.log(`        ${r.goed ? '✓' : '✗'} ${r.naam}: ${r.detail}`);
      }
      keuringsuitslag = rapport;
    } catch (e) {
      console.log(`     keuring overgeslagen (${(e as Error).message.slice(0, 70)})`);
    }

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

    // De keuringsuitslag reist mee met het bestand: in het dashboard zie je zo
    // per clip of hij door alle regels kwam, zonder de log te hoeven lezen.
    bestanden.push({
      naam,
      pad,
      bytes: size,
      keuring: keuringsuitslag
        ? {
            goed: keuringsuitslag.goed,
            regels: keuringsuitslag.regels.map((r) => ({ naam: r.naam, goed: r.goed, detail: r.detail })),
          }
        : null,
    });
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
 * Meet fijnmazig waar de spreker staat gedurende een shot, zodat de uitsnede
 * hem kan volgen in plaats van uit te zoomen tot alle uitersten passen.
 *
 * Alleen voor shots waar het nodig is: het kost een meting per driekwart
 * seconde, en op een statische talking head verandert er toch niets.
 */
async function meetSpoor(bronPad: string, segmenten: Shot[]): Promise<number> {
  // Alle shots van betekenis fijnmazig meten. De oude poort — alleen volgen
  // als de grove 3-puntsmeting beweging zag — was stuk: het uitschieterfilter
  // van die meting gooide een échte verplaatsing (0,60 → 0,82, de wegleun in
  // het slotshot) weg als meetfout, waarna er niet gevolgd werd en de spreker
  // zijn statische kader uitliep. Het spoor zelf beslist nu of er beweging is.
  const teVolgen = segmenten.filter((s) => s.end - s.start >= 2.5 && !s.focus);
  if (teVolgen.length === 0) return 0;

  const STAP = 0.75;
  const opdrachten: { seg: Shot; tijden: number[] }[] = teVolgen.map((seg) => {
    const tijden: number[] = [];
    for (let t = seg.start; t < seg.end; t += STAP) tijden.push(t);
    tijden.push(seg.end - 0.05);
    return { seg, tijden };
  });

  const alle = opdrachten.flatMap((o) => o.tijden);
  let posities: ({ x: number; breedte?: number } | null)[] = [];
  try {
    const py = pythonMetOpenCV();
    const uit = await new Promise<string>((klaar, fout) => {
      // Eén frame per meetpunt: we willen hier fijnmazigheid, geen robuustheid
      // per punt — het gladstrijken daarna vangt de uitschieters op.
      // Drie frames per meetpunt in plaats van één: met één frame kan de
      // mondbewegings-stemming niet werken en pakte de detectie zo nu en dan
      // de gesprekspartner — in het spoor oogde dat als een sprong van een
      // halve beeldbreedte, en dáár vuurde de sprekerswissel-splitsing op.
      const kind = spawn(py.cmd, [...py.voor, 'scripts/gezichten.py', bronPad, JSON.stringify(alle), '3']);
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
    // Absolute brontijd, niet relatief aan de shotstart: de knip- en
    // aanloopcontrole mogen de grens later nog verschuiven, en een relatief
    // spoor schuift dan mee scheef — de camera volgde dan een spook.
    const ruw = tijden.map((t, i) => ({ t, meting: posities[index + i] ?? null }));
    index += tijden.length;
    // Identiteit en positie zijn twee verschillende vragen. Wíé we volgen is
    // al beslist door de grove meting (vijf frames per punt, stemming op
    // mondbeweging): dat is het anker. Het fijnspoor mag alleen bepalen wáár
    // die persoon op elk moment is — een meting die ver van het anker ligt is
    // de gesprekspartner en wordt verworpen. Zonder deze scheiding wisselde
    // het spoor per run van persoon.
    // Identiteit bewaken zonder échte beweging te blokkeren. Twee eerdere
    // pogingen faalden allebei op een helft van het probleem: vergelijken met
    // het globale midden verwierp juist de grote wegleunbeweging, en
    // "geloof een sprong als het volgende punt hem bevestigt" trapte erin
    // zodra de gesprekspartner twéé keer achter elkaar gedetecteerd werd
    // (gemeten: 0,60 → 0,07 → 0,11 → 0,72; het kader zwaaide door het midden
    // en zette de spreker tegen de rand).
    //
    // Het echte onderscheid is dat twee mensen twee groepen posities vormen.
    // Dus: alle metingen clusteren, de groep kiezen die hoort bij de spreker
    // (bepaald met de robuuste vijf-frame-meting), en de rest laten vallen.
    // Beweegt iemand geleidelijk ver opzij, dan blijft dat één groep en gaat
    // het kader gewoon mee.
    const CLUSTER = 0.25;
    const groepen: { punten: number[]; midden: number }[] = [];
    for (const r of ruw) {
      const x = r.meting?.x;
      if (x === undefined) continue;
      const bij = groepen.find((g) => Math.abs(g.midden - x) <= CLUSTER);
      if (bij) {
        bij.punten.push(x);
        bij.midden = bij.punten.reduce((a, b) => a + b, 0) / bij.punten.length;
      } else {
        groepen.push({ punten: [x], midden: x });
      }
    }
    const spreker = seg.focusX;
    const eigenGroep =
      groepen.length <= 1
        ? groepen[0]
        : spreker !== undefined
          ? groepen.reduce((a, b) => (Math.abs(b.midden - spreker) < Math.abs(a.midden - spreker) ? b : a))
          : groepen.reduce((a, b) => (b.punten.length > a.punten.length ? b : a));

    const metingen = ruw.map((r) => {
      const x = r.meting?.x;
      if (x === undefined) return { t: r.t, x: null };
      if (eigenGroep && Math.abs(x - eigenGroep.midden) > CLUSTER * 1.6) return { t: r.t, x: null };
      return { t: r.t, x };
    });

    if (metingen.filter((m) => m.x !== null).length < 2) continue;

    const spoor = maakSpoor(metingen);
    const xs = spoor.map((punt) => punt.x);
    const bereik = Math.max(...xs) - Math.min(...xs);
    // De werkelijke beweging vervangt de grove 3-puntsschatting; daar rekent
    // het zoomplafond mee.
    seg.spreiding = bereik;

    if (bereik < 0.05) continue; // statisch: geen spoor nodig

    seg.spoor = spoor;

    // Sprong of glijer? Een sprekerswissel is een sprong (grote stap tussen
    // twee opeenvolgende metingen); een wegleunende spreker glijdt.
    const ruweXs = metingen.filter((m): m is { t: number; x: number } => m.x !== null);
    let maxStap = 0;
    for (let k = 1; k < ruweXs.length; k++) {
      maxStap = Math.max(maxStap, Math.abs(ruweXs[k].x - ruweXs[k - 1].x));
    }
    seg.maxStap = maxStap;

    // Ooghoogte meesporen: wie naar voren leunt zakt ook in beeld, en een
    // statische verticale kadrering snijdt dan de kruin of de kin af.
    const oogMetingen = ruw.map((r) => ({
      t: r.t,
      x: (r.meting as { oog?: number } | null)?.oog ?? null,
    }));
    if (oogMetingen.filter((m) => m.x !== null).length >= 2) {
      seg.spoorY = maakSpoor(oogMetingen).map((punt) => ({
        t: punt.t,
        x: Math.min(0.85, Math.max(0.15, punt.x + 0.06)),
      }));
    }

    // De kleinste gezichtsbreedte over het hele shot: daar dimensioneert de
    // zoom op, zodat de spreker ook op zijn verste moment groot in beeld staat.
    const breedtes = ruw
      .map((r) => (r.meting as { breedte?: number } | null)?.breedte)
      .filter((b): b is number => typeof b === 'number' && b > 0.02);
    if (breedtes.length > 0) seg.focusWmin = Math.min(seg.focusWmin ?? 1, ...breedtes);
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
      // Ook de kleinste meting bewaren: bij een gevolgd shot moet de zoom
      // daarop dimensioneren, anders wordt de spreker klein zodra hij wegleunt.
      s.focusWmin = ws[0];

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
