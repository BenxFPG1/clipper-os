import { fetchYoutubeCaptions, voerYtdlpUit } from './youtube';
import { transcribeYoutube } from './whisper';
import { transcriptDuration } from './transcript';
import { db } from '../supabase';
import { bronSleutel, herkenBron, kanaalKandidaten } from './bron-url';
import { haalDirecteBronBinnen } from './directe-bron';

export type KanaalVideo = { id: string; title: string; url: string };

/**
 * Leest de laatste uploads van een YouTube-kanaal (of playlist) uit met
 * yt-dlp's flat-playlist: geen downloads, alleen de lijst. Zo hoeft niemand
 * handmatig video's toe te voegen.
 */
export async function haalKanaalVideos(kanaalUrl: string, maxItems = 10): Promise<KanaalVideo[]> {
  const bron = herkenBron(kanaalUrl);
  // Een losse video-URL is zélf het bronmateriaal. Niet het kanaal erachter
  // afstruinen: campagnes gaan vaak over precies één aflevering.
  if (bron.soort === 'youtube_video') {
    const uit = await voerYtdlpUit(['--no-warnings', '--skip-download', '--dump-json', bron.url]);
    return parseerRegels(uit);
  }
  if (bron.soort === 'onbekend') throw new Error(bron.reden);
  if (bron.soort !== 'youtube_kanaal' && bron.soort !== 'youtube_playlist') {
    throw new Error(`Geen YouTube-bron: ${kanaalUrl}`);
  }

  // Niet elk kanaal heeft dezelfde tabs: sommige publiceren alleen streams of
  // shorts, en dan geeft /videos een harde fout. We proberen op volgorde en
  // nemen de eerste tab die iets oplevert.
  const kandidaten = bron.soort === 'youtube_kanaal' ? kanaalKandidaten(bron) : [bron.url];
  let laatsteFout: Error | null = null;
  for (const url of kandidaten) {
    try {
      const uit = await voerYtdlpUit([
        '--no-warnings',
        '--extractor-args',
        'youtubetab:skip=authcheck',
        '--flat-playlist',
        '--dump-json',
        '--playlist-end',
        String(maxItems),
        url,
      ]);
      const videos = parseerRegels(uit);
      if (videos.length > 0) return videos;
    } catch (e) {
      laatsteFout = e as Error;
      // Een 404 op het kanaal zelf geldt voor elke tab: het kanaal bestaat
      // niet (meestal een verkeerde handle). Niet nog twee tabs proberen.
      if (isKanaal404(laatsteFout.message)) {
        throw new Error(kanaal404Melding(bron.soort === 'youtube_kanaal' ? (bron.handle ?? bron.basis) : bron.url));
      }
    }
  }
  if (laatsteFout) throw laatsteFout;
  return [];
}

/** yt-dlp's melding voor een kanaal of playlist dat niet bestaat. */
export function isKanaal404(melding: string): boolean {
  return /HTTP Error 404|Requested entity was not found|does not exist|This channel does not exist/i.test(melding);
}

export function kanaal404Melding(naam: string): string {
  return `YouTube-kanaal ${naam} bestaat niet (404) — controleer de handle op youtube.com en vervang de link door het juiste kanaal of de losse video.`;
}

/** Herkent een losse video-URL (watch?v=…, youtu.be/…, /shorts/…). */
function losseVideoId(url: string): string | null {
  const b = herkenBron(url);
  return b.soort === 'youtube_video' ? b.videoId : null;
}

function parseerRegels(uit: string): KanaalVideo[] {
  const videos: KanaalVideo[] = [];
  for (const regel of uit.split('\n')) {
    if (!regel.trim()) continue;
    try {
      const j = JSON.parse(regel) as { id?: string; title?: string; url?: string };
      if (!j.id) continue;
      videos.push({
        id: j.id,
        title: j.title ?? 'Naamloze video',
        url: `https://www.youtube.com/watch?v=${j.id}`,
      });
    } catch {
      // Losse regel onparseerbaar: overslaan, de rest telt.
    }
  }
  return videos;
}

/**
 * Zelf transcriberen kost ongeveer een halve minuut per minuut video. Met een
 * grens per run blijft één cloudrun binnen zijn tijdslimiet; wat overblijft
 * komt de volgende run vanzelf aan de beurt. Twee grenzen: een aantal, en
 * een tijdsbudget (na KANAAL_BUDGET_MIN minuten begint er geen nieuwe video
 * meer — de denkopdrachten na deze stap hebben ook nog tijd nodig).
 */
const MAX_NIEUWE_PER_RUN = Number(process.env.MAX_NIEUWE_VIDEOS_PER_RUN ?? 4);
const BUDGET_MS = Number(process.env.KANAAL_BUDGET_MIN ?? 60) * 60_000;

/**
 * Haalt nieuwe video's binnen uit de bronnen van alle actieve campagnes —
 * YouTube-kanalen en -video's, Drive-bestanden en -mappen, WeTransfers —
 * inclusief transcript, en zet er meteen een clip-plan-opdracht op als de
 * campagne dat aan heeft staan. Optioneel alleen voor één campagne.
 */
export async function haalNieuweBronvideos(opties: { campaignId?: string } = {}): Promise<{
  toegevoegd: { videoId: string; titel: string; campagne: string }[];
  fouten: string[];
}> {
  const supabase = db();
  const toegevoegd: { videoId: string; titel: string; campagne: string }[] = [];
  const fouten: string[] = [];
  const t0 = Date.now();
  // `extra`: wat een lopende Drive/WeTransfer-ophaalronde zelf al heeft
  // toegevoegd — die komen pas na afloop in `toegevoegd`. Zonder dit haalde
  // één Drive-map alle zes video's binnen bij een grens van één.
  const magNog = (extra = 0) => toegevoegd.length + extra < MAX_NIEUWE_PER_RUN && Date.now() - t0 < BUDGET_MS;
  const grensMelding = () =>
    toegevoegd.length >= MAX_NIEUWE_PER_RUN
      ? `grens van ${MAX_NIEUWE_PER_RUN} nieuwe video's per run bereikt — de rest komt bij de volgende run.`
      : `tijdsbudget van ${Math.round(BUDGET_MS / 60_000)} min voor ophalen op — de rest komt bij de volgende run.`;

  let query = supabase
    .from('campaigns')
    .select('id, name, bron_kanaal_url, bron_kanalen, auto_plan, platform_rules, kanaal_check_gestart_at')
    .eq('status', 'active');
  if (opties.campaignId) query = query.eq('id', opties.campaignId);
  const { data: campagnes, error } = await query;
  if (error) throw error;

  for (const campagne of campagnes ?? []) {
    // Zegt de campagne dat alleen het aangeleverde bronmateriaal gebruikt mag
    // worden, dan halen we nooit het hele kanaal binnen — alleen losse video's
    // en wat de campagne zelf aanlevert (Drive, WeTransfer).
    const alleenBronvideo = Boolean(
      (campagne.platform_rules as { alleen_bronvideo?: boolean } | null)?.alleen_bronvideo,
    );
    // De lijst is leidend; bron_kanaal_url blijft meelopen voor oude rijen.
    const kanalen = [
      ...((campagne.bron_kanalen as string[] | null) ?? []),
      ...(campagne.bron_kanaal_url ? [campagne.bron_kanaal_url as string] : []),
    ]
      .map((k) => k.trim())
      .filter(Boolean);
    let uniek = [...new Set(kanalen)];
    if (alleenBronvideo) {
      const aangeleverd = uniek.filter((k) => {
        const soort = herkenBron(k).soort;
        return soort !== 'youtube_kanaal' && soort !== 'youtube_playlist';
      });
      if (aangeleverd.length !== uniek.length) {
        fouten.push(
          `${campagne.name}: campagne staat alleen het aangeleverde bronmateriaal toe — kanaalbronnen overgeslagen.`,
        );
      }
      uniek = aangeleverd;
    }
    if (uniek.length === 0) {
      // Geen bron geconfigureerd, dus deze campagne wordt niet gecheckt. Was
      // hij (bijvoorbeeld door een handmatige klik) toch als "bezig" gezet,
      // dan zou hij anders voor altijd op "bezig" blijven staan in de UI.
      if (campagne.kanaal_check_gestart_at) {
        await supabase.from('campaigns').update({ kanaal_check_gestart_at: null }).eq('id', campagne.id);
      }
      continue;
    }

    // Zichtbaar maken dat deze campagne nu daadwerkelijk gecheckt wordt —
    // niet alleen dat de cloudrun is gestart (dat kan een minuut duren voor
    // hij hier komt), maar het moment dat de scan van déze campagne begint.
    await supabase.from('campaigns').update({ kanaal_check_gestart_at: new Date().toISOString() }).eq('id', campagne.id);

    const foutenVoorCampagne = fouten.length;
    try {
      // Wat we al hebben (ook gearchiveerd) slaan we over. Op bronsleutel:
      // youtu.be en watch?v= zijn dezelfde video, net als een Drive-link met
      // of zonder ?usp=sharing.
      const { data: bestaand } = await supabase.from('videos').select('source_url').eq('campaign_id', campagne.id);
      const bekend = new Set(
        (bestaand ?? []).map((v) => bronSleutel(v.source_url as string | null)).filter((x): x is string => Boolean(x)),
      );

      // Alle bronnen van deze campagne; per bron een eigen foutmelding,
      // zodat één kapotte bron de rest niet blokkeert. De bron-URL staat in
      // elke melding: daarop toont de campagnepagina de status per bron.
      const kanaalVideos: KanaalVideo[] = [];
      for (const kanaal of uniek) {
        const bron = herkenBron(kanaal);
        if (bron.soort === 'onbekend') {
          fouten.push(`${campagne.name} / ${kanaal}: ${bron.reden}`);
          continue;
        }
        if (bron.soort === 'drive_map' || bron.soort === 'drive_bestand' || bron.soort === 'wetransfer' || bron.soort === 'wetransfer_kort') {
          if (!magNog()) {
            fouten.push(`${campagne.name} / ${kanaal}: ${grensMelding()}`);
            continue;
          }
          try {
            const r = await haalDirecteBronBinnen({
              campaignId: campagne.id as string,
              bron: kanaal,
              bekend,
              magNog,
              autoPlan: campagne.auto_plan !== false,
            });
            for (const t of r.toegevoegd) toegevoegd.push({ ...t, campagne: campagne.name as string });
            for (const f of r.fouten) fouten.push(`${campagne.name} / ${kanaal}: ${f}`);
            if (r.resterend > 0) fouten.push(`${campagne.name} / ${kanaal}: nog ${r.resterend} video('s) te gaan — ${grensMelding()}`);
          } catch (e) {
            fouten.push(`${campagne.name} / ${kanaal}: ${e instanceof Error ? e.message : String(e)}`);
          }
          continue;
        }
        try {
          kanaalVideos.push(...(await haalKanaalVideos(kanaal, 10)));
        } catch (e) {
          fouten.push(`${campagne.name} / ${kanaal}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      for (const kv of kanaalVideos) {
        const sleutel = `yt:${kv.id}`;
        if (bekend.has(sleutel)) continue;
        if (!magNog()) {
          fouten.push(`${campagne.name}: ${grensMelding()}`);
          break;
        }
        bekend.add(sleutel); // twee bronnen kunnen dezelfde video bevatten

        const transcript = await haalTranscript(kv.url);
        if (!('segments' in transcript)) {
          fouten.push(`${kv.title}: geen transcript — ${transcript.fout?.slice(0, 200)}`);
          continue;
        }

        const { data: rij, error: insertError } = await supabase
          .from('videos')
          .insert({
            campaign_id: campagne.id,
            title: kv.title,
            source_url: kv.url,
            duration_seconds: transcript.duur,
            transcript: transcript.segments,
            transcript_raw: JSON.stringify(transcript.segments),
            transcript_source: transcript.bron,
            auto_toegevoegd: true,
          })
          .select('id')
          .single();
        if (insertError) {
          fouten.push(`${kv.title}: ${insertError.message}`);
          continue;
        }

        toegevoegd.push({ videoId: rij.id as string, titel: kv.title, campagne: campagne.name as string });

        // Meteen een plan laten maken; de worker draait toch al.
        if (campagne.auto_plan !== false) {
          const { data: staatAl } = await supabase
            .from('ai_jobs')
            .select('id')
            .eq('soort', 'clip_plan')
            .eq('doel_id', rij.id)
            .in('status', ['wachtend', 'bezig'])
            .limit(1)
            .maybeSingle();
          if (!staatAl) {
            await supabase.from('ai_jobs').insert({ soort: 'clip_plan', doel_id: rij.id, parameters: {} });
          }
        }
      }
    } catch (e) {
      fouten.push(`${campagne.name}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Altijd bewaren wat er misging bij déze campagne — ook (juist) als geen
    // enkele bron iets opleverde. Eerder sloeg een `continue` bij nul video's
    // deze stap over: de Drive-, WeTransfer- en kanaalfouten kwamen nooit in
    // de UI en de campagne bleef eeuwig op "bezig" staan.
    const eigenFouten = fouten.slice(foutenVoorCampagne);
    await supabase
      .from('campaigns')
      .update({
        laatste_kanaal_check: new Date().toISOString(),
        laatste_kanaal_fouten: eigenFouten.slice(-10),
        kanaal_check_gestart_at: null,
      })
      .eq('id', campagne.id);
  }

  return { toegevoegd, fouten };
}

async function haalTranscript(url: string) {
  const captions = await fetchYoutubeCaptions(url).catch(() => null);
  if (captions) {
    return {
      segments: captions.segments,
      duur: captions.durationSeconds ?? Math.round(transcriptDuration(captions.segments)),
      bron: 'youtube_captions' as const,
      fout: null,
    };
  }
  try {
    const t = await transcribeYoutube(url);
    return {
      segments: t.segments,
      duur: t.durationSeconds ?? Math.round(transcriptDuration(t.segments)),
      bron: 'whisper' as const,
      fout: null,
    };
  } catch (e) {
    // Geen captions én zelf transcriberen lukt niet: de reden is bruikbaar
    // (meestal een ontbrekende of verkeerde transcriptie-key).
    return { fout: e instanceof Error ? e.message : String(e) } as const;
  }
}
