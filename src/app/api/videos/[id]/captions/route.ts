import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { bouwSrt, type TranscriptSegment } from '@/lib/roughcut/srt';
import type { PlanShot } from '@/lib/roughcut/project-opbouw';

/**
 * Ondertiteling (.srt) voor één clip uit het plan. Premiere kan zelf
 * transcriberen, maar wij hebben het transcript al met tijdcodes — dit scheelt
 * die stap én de correctieronde erna, omdat het dezelfde tekst is waarop het
 * plan gebouwd is.
 *
 *   /api/videos/<id>/captions?clip=3
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const clipNummer = Number(req.nextUrl.searchParams.get('clip') ?? '1');

  const supabase = db();
  const { data: video, error } = await supabase
    .from('videos')
    .select('title, transcript')
    .eq('id', params.id)
    .single();
  if (error || !video) return NextResponse.json({ error: 'Video niet gevonden' }, { status: 404 });

  const transcript = (video.transcript ?? []) as TranscriptSegment[];
  if (transcript.length === 0) {
    return NextResponse.json({ error: 'Deze video heeft geen transcript' }, { status: 400 });
  }

  const { data: planRij } = await supabase
    .from('clip_plans')
    .select('plan')
    .eq('video_id', params.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const clips = ((planRij?.plan as { clips?: unknown[] } | null)?.clips ?? []) as {
    titel_intern: string;
    shots: PlanShot[];
  }[];
  const clip = clips[clipNummer - 1];
  if (!clip) return NextResponse.json({ error: `Clip ${clipNummer} bestaat niet` }, { status: 404 });

  const srt = bouwSrt(clip.shots, transcript);
  const naam = `${String(clipNummer).padStart(2, '0')}-${clip.titel_intern
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 45)}.srt`;

  return new NextResponse(srt, {
    headers: {
      'content-type': 'application/x-subrip; charset=utf-8',
      'content-disposition': `attachment; filename="${naam}"`,
    },
  });
}
