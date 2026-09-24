import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { fetchYoutubeCaptions } from '@/lib/ingest/youtube';
import { MissingBinaryError, transcribeYoutube } from '@/lib/ingest/whisper';
import { parseManualTranscript, transcriptDuration } from '@/lib/ingest/transcript';
import { startCloudRun } from '@/lib/jobs';

export const maxDuration = 300;

/**
 * Voegt een bronvideo toe. Drie ingangen (sectie 5):
 * - source_url met captions: die halen we op
 * - source_url zonder captions: we bouwen zelf een transcript (yt-dlp + Whisper)
 * - transcript_text: handmatig geplakt transcript met tijdcodes
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    campaign_id: string;
    title?: string;
    source_url?: string;
    transcript_text?: string;
    /** Captions overslaan en meteen zelf transcriberen (betere tijdcodes). */
    force_transcribe?: boolean;
  };

  if (!body.campaign_id) {
    return NextResponse.json({ error: 'campaign_id is verplicht' }, { status: 400 });
  }

  let segments;
  let source: 'youtube_captions' | 'whisper' | 'manual';
  let title = body.title ?? null;
  let duration: number | null = null;
  let raw = body.transcript_text ?? null;

  if (body.transcript_text?.trim()) {
    segments = parseManualTranscript(body.transcript_text);
    source = 'manual';
    if (segments.length === 0) {
      return NextResponse.json(
        { error: 'Geen tijdcodes gevonden. Verwacht regels als "0:07 tekst".' },
        { status: 400 },
      );
    }
  } else if (body.source_url) {
    // Captions eerst: gratis en direct. Anders bouwen we het transcript zelf.
    const captions = body.force_transcribe ? null : await fetchYoutubeCaptions(body.source_url).catch(() => null);

    if (captions) {
      segments = captions.segments;
      source = 'youtube_captions';
      title = title ?? captions.title;
      duration = captions.durationSeconds;
      raw = JSON.stringify(captions.segments);
    } else {
      try {
        const transcribed = await transcribeYoutube(body.source_url);
        segments = transcribed.segments;
        source = 'whisper';
        title = title ?? transcribed.title;
        duration = transcribed.durationSeconds;
        raw = JSON.stringify(transcribed.segments);
      } catch (e) {
        if (e instanceof MissingBinaryError) {
          // Op de live site is er geen yt-dlp/Whisper. Net als bij plannen
          // en scripts gaat het werk dan naar de cloudwachtrij in plaats
          // van een kale 503; de worker maakt het transcript en de video.
          return NextResponse.json(await zetTranscriptInWachtrij(body));
        }
        return NextResponse.json(
          { error: `Transcriberen mislukt: ${e instanceof Error ? e.message : String(e)}` },
          { status: 502 },
        );
      }
    }
  } else {
    return NextResponse.json({ error: 'Geef source_url of transcript_text mee' }, { status: 400 });
  }

  const { data, error } = await db()
    .from('videos')
    .insert({
      campaign_id: body.campaign_id,
      title: title ?? 'Naamloze video',
      source_url: body.source_url ?? null,
      duration_seconds: duration ?? Math.round(transcriptDuration(segments)),
      transcript: segments,
      transcript_raw: raw,
      transcript_source: source,
    })
    .select()
    .single();

  if (error) {
    // videos_bron_uniek (schema.sql): dezelfde URL twee keer in één campagne.
    // De kale Postgres-tekst "duplicate key value violates…" zegt de
    // gebruiker niets.
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Deze video staat al in deze campagne.' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ video: data, segments: segments.length });
}

/**
 * Transcript in de cloud laten maken. Niet via queueAiJob: die ontdubbelt op
 * (soort, doel_id) en doel_id is hier de campagne — twee verschillende
 * video's voor dezelfde campagne zouden dan op elkaar wachten. Hier
 * ontdubbelen we op de bron-URL zelf.
 */
async function zetTranscriptInWachtrij(body: {
  campaign_id: string;
  source_url?: string;
  title?: string;
  force_transcribe?: boolean;
}) {
  const supabase = db();

  const { data: bestaandeVideo } = await supabase
    .from('videos')
    .select('id')
    .eq('campaign_id', body.campaign_id)
    .eq('source_url', body.source_url as string)
    .is('archived_at', null)
    .limit(1);
  if (bestaandeVideo?.length) {
    throw Object.assign(new Error('Deze video staat al in deze campagne.'), { status: 409 });
  }

  const { data: bestaand } = await supabase
    .from('ai_jobs')
    .select('id')
    .eq('soort', 'video_transcript')
    .eq('doel_id', body.campaign_id)
    .eq('parameters->>source_url', body.source_url as string)
    .in('status', ['wachtend', 'bezig'])
    .limit(1);

  let jobId = bestaand?.[0]?.id as string | undefined;
  if (!jobId) {
    const { data, error } = await supabase
      .from('ai_jobs')
      .insert({
        soort: 'video_transcript',
        doel_id: body.campaign_id,
        parameters: {
          source_url: body.source_url,
          title: body.title ?? null,
          force_transcribe: Boolean(body.force_transcribe),
        },
      })
      .select('id')
      .single();
    if (error) {
      // De check-constraint kent 'video_transcript' nog niet: schema.sql is
      // niet bijgewerkt in Supabase.
      const hint = /ai_jobs_soort_check/.test(error.message)
        ? ' (draai het ai_jobs_soort_check-blok uit supabase/schema.sql in de Supabase SQL-editor)'
        : '';
      throw new Error(error.message + hint);
    }
    jobId = data.id as string;
  }

  const directGestart = await startCloudRun('ai-jobs.yml');
  return {
    inWachtrij: true,
    jobId,
    directGestart,
    alInWachtrij: Boolean(bestaand?.length),
    melding: directGestart
      ? 'Geen ondertiteling gevonden; het transcript wordt nu in de cloud gemaakt. De video staat er over een paar minuten.'
      : 'Geen ondertiteling gevonden; het transcript staat in de wachtrij voor de volgende cloudrun.',
  };
}

export async function GET() {
  const { data, error } = await db()
    .from('videos')
    .select('id, title, source_url, duration_seconds, transcript_source, created_at, campaign_id')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ videos: data });
}
