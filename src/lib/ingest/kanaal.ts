import { spawn } from 'node:child_process';
import { resolveBinary } from './binaries';
import { fetchYoutubeCaptions, ytdlpAuthArgs } from './youtube';
import { transcribeYoutube } from './whisper';
import { transcriptDuration } from './transcript';
import { db } from '../supabase';

export type KanaalVideo = { id: string; title: string; url: string };

/**
 * Leest de laatste uploads van een YouTube-kanaal (of playlist) uit met
 * yt-dlp's flat-playlist: geen downloads, alleen de lijst. Zo hoeft niemand
 * handmatig video's toe te voegen.
 */
export async function haalKanaalVideos(kanaalUrl: string, maxItems = 10): Promise<KanaalVideo[]> {
  // Een losse video-URL is zélf het bronmateriaal. Niet het kanaal erachter
  // afstruinen: campagnes gaan vaak over precies één aflevering.
  const videoId = losseVideoId(kanaalUrl);
  if (videoId) {
    const uit = await run(resolveBinary('yt-dlp'), [
      ...ytdlpAuthArgs(),
      '--no-warnings',
      '--skip-download',
      '--dump-json',
      kanaalUrl.trim(),
    ]);
    return parseerRegels(uit);
  }

  // Niet elk kanaal heeft dezelfde tabs: sommige publiceren alleen streams of
  // shorts, en dan geeft /videos een harde fout. We proberen op volgorde en
  // nemen de eerste tab die iets oplevert.
  let laatsteFout: Error | null = null;
  for (const url of kandidaatUrls(kanaalUrl)) {
    try {
      const uit = await run(resolveBinary('yt-dlp'), [
        ...ytdlpAuthArgs(),
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
    }
  }
  if (laatsteFout) throw laatsteFout;
  return [];
}

/** Herkent een losse video-URL (watch?v=… of youtu.be/…). */
function losseVideoId(url: string): string | null {
  const m = url.match(/[?&]v=([\w-]{6,})/) ?? url.match(/youtu\.be\/([\w-]{6,})/);
  return m?.[1] ?? null;
}

/** Kanaal-URL zonder tab wijst naar de homepage; probeer de tabs op volgorde. */
function kandidaatUrls(kanaalUrl: string): string[] {
  const schoon = kanaalUrl.trim().replace(/\/+$/, '');
  if (/\/(videos|streams|shorts|playlist)/.test(schoon) || schoon.includes('list=')) return [schoon];
  return [`${schoon}/videos`, `${schoon}/streams`, `${schoon}/shorts`, schoon];
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
 * Haalt nieuwe uploads van de kanalen van alle campagnes binnen, inclusief
 * transcript, en zet er meteen een clip-plan-opdracht op als de campagne dat
 * aan heeft staan.
 */
/**
 * Zelf transcriberen kost ongeveer een halve minuut per minuut video. Met een
 * grens per run blijft één cloudrun binnen zijn tijdslimiet; wat overblijft
 * komt de volgende run vanzelf aan de beurt.
 */
const MAX_NIEUWE_PER_RUN = Number(process.env.MAX_NIEUWE_VIDEOS_PER_RUN ?? 3);

export async function haalNieuweBronvideos(): Promise<{
  toegevoegd: { videoId: string; titel: string; campagne: string }[];
  fouten: string[];
}> {
  const supabase = db();
  const toegevoegd: { videoId: string; titel: string; campagne: string }[] = [];
  const fouten: string[] = [];

  const { data: campagnes, error } = await supabase
    .from('campaigns')
    .select('id, name, bron_kanaal_url, bron_kanalen, auto_plan, platform_rules')
    .eq('status', 'active');
  if (error) throw error;

  for (const campagne of campagnes ?? []) {
    // Zegt de campagne dat alleen het aangeleverde bronmateriaal gebruikt mag
    // worden, dan halen we nooit het hele kanaal binnen — alleen losse video's
    // die expliciet als bron zijn opgegeven.
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
      const alleenVideos = uniek.filter((k) => losseVideoId(k));
      if (alleenVideos.length !== uniek.length) {
        fouten.push(
          `${campagne.name}: campagne staat alleen het aangeleverde bronmateriaal toe — kanaalbronnen overgeslagen.`,
        );
      }
      uniek = alleenVideos;
    }
    if (uniek.length === 0) continue;

    try {
      // Alle bronnen van deze campagne samen; per bron een eigen foutmelding,
      // zodat één kapot kanaal de rest niet blokkeert.
      const kanaalVideos: KanaalVideo[] = [];
      for (const kanaal of uniek) {
        try {
          kanaalVideos.push(...(await haalKanaalVideos(kanaal, 10)));
        } catch (e) {
          fouten.push(`${campagne.name} / ${kanaal}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (kanaalVideos.length === 0) continue;

      // Wat we al hebben (ook gearchiveerd) slaan we over.
      const { data: bestaand } = await supabase
        .from('videos')
        .select('source_url')
        .eq('campaign_id', campagne.id);
      const bekend = new Set((bestaand ?? []).map((v) => videoIdUit(v.source_url as string | null)).filter(Boolean));

      for (const kv of kanaalVideos) {
        if (toegevoegd.length >= MAX_NIEUWE_PER_RUN) {
          fouten.push(
            `${campagne.name}: grens van ${MAX_NIEUWE_PER_RUN} nieuwe video's per run bereikt — de rest komt bij de volgende run.`,
          );
          break;
        }
        if (bekend.has(kv.id)) continue;
        bekend.add(kv.id); // twee bronnen kunnen dezelfde video bevatten

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
          await supabase.from('ai_jobs').insert({ soort: 'clip_plan', doel_id: rij.id, parameters: {} });
        }
      }

      // Bewaar wat er misging bij déze campagne, zodat een verkeerde bron of
      // een mislukt transcript zichtbaar is in de UI en niet alleen in de logs.
      const eigenFouten = fouten.filter((f) => f.startsWith(campagne.name as string) || f.includes(': geen transcript'));
      await supabase
        .from('campaigns')
        .update({
          laatste_kanaal_check: new Date().toISOString(),
          laatste_kanaal_fouten: eigenFouten.slice(-10),
        })
        .eq('id', campagne.id);
    } catch (e) {
      fouten.push(`${campagne.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
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

function videoIdUit(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/[?&]v=([\w-]{6,})/) ?? url.match(/youtu\.be\/([\w-]{6,})/);
  return m?.[1] ?? null;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exit ${code}: ${stderr.trim().slice(-300)}`)),
    );
  });
}
