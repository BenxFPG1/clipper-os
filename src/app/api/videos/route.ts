import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { fetchYoutubeCaptions } from '@/lib/ingest/youtube';
import { parseManualTranscript, transcriptDuration } from '@/lib/ingest/transcript';

export const maxDuration = 60;

/**
 * Voegt een bronvideo toe. Twee ingangen (sectie 5):
 * - source_url: YouTube-captions ophalen
 * - transcript_text: handmatig geplakt transcript met tijdcodes
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    campaign_id: string;
    title?: string;
    source_url?: string;
    transcript_text?: string;
  };

  if (!body.campaign_id) {
    return NextResponse.json({ error: 'campaign_id is verplicht' }, { status: 400 });
  }

  let segments;
  let source: 'youtube_captions' | 'manual';
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
    const captions = await fetchYoutubeCaptions(body.source_url).catch((e) => {
      throw new Error(`Captions ophalen mislukt: ${e instanceof Error ? e.message : e}`);
    });
    if (!captions) {
      return NextResponse.json(
        { error: 'Deze video heeft geen captions. Plak het transcript handmatig of gebruik Whisper.' },
        { status: 422 },
      );
    }
    segments = captions.segments;
    source = 'youtube_captions';
    title = title ?? captions.title;
    duration = captions.durationSeconds;
    raw = JSON.stringify(captions.segments);
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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ video: data, segments: segments.length });
}

export async function GET() {
  const { data, error } = await db()
    .from('videos')
    .select('id, title, source_url, duration_seconds, transcript_source, created_at, campaign_id')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ videos: data });
}
