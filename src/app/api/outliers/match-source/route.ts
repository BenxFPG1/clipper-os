import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { Platform, getMetricsProvider } from '@/lib/tracking/provider';
import { TranscriptSegment } from '@/lib/ingest/transcript';
import { matchClipInVideos, vttNaarTekst } from '@/lib/matching';

export const maxDuration = 300;

/**
 * Zoekt terug uit welk moment van onze bronvideo's een gevonden clip geknipt is.
 *
 * Dit is de kern van "content intelligence": niet leren dát een clip werkte,
 * maar wélk moment iemand uit een uur materiaal koos. Als een concurrent onze
 * bronvideo knipt en daarmee scoort, weten we precies welk fragment hij pakte —
 * en kunnen we dat moment zelf beter uitwerken.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { findId?: string; alle?: boolean };
  const supabase = db();

  const { data: videos, error: videoError } = await supabase
    .from('videos')
    .select('id, title, transcript')
    .not('transcript', 'is', null);
  if (videoError) return NextResponse.json({ error: videoError.message }, { status: 500 });
  if (!videos?.length) {
    return NextResponse.json({ error: 'Geen bronvideo\'s met transcript om tegen te matchen.' }, { status: 422 });
  }

  const bronnen = videos.map((v) => ({
    id: v.id as string,
    title: v.title as string,
    transcript: v.transcript as TranscriptSegment[],
  }));

  // Eén vondst, of alles wat nog geen bronmatch heeft.
  // TikTok en Shorts hebben allebei een transcriptbron; Reels niet.
  let query = supabase.from('scout_finds').select('*').in('platform', ['tiktok', 'shorts']);
  if (body.findId) query = query.eq('id', body.findId);
  else query = query.limit(15);

  const { data: finds, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const provider = getMetricsProvider();
  const resultaten: { post_url: string; match: unknown }[] = [];

  for (const find of finds ?? []) {
    const decoded = (find.decoded ?? {}) as Record<string, unknown>;
    if (!body.findId && decoded.bron_match) continue;

    try {
      let vtt = find.transcript as string | null;
      if (!vtt) {
        vtt = (await provider.fetchTranscript?.(find.post_url, find.platform as Platform)) ?? null;
        if (vtt) await supabase.from('scout_finds').update({ transcript: vtt }).eq('id', find.id);
      }
      if (!vtt) continue;

      const match = matchClipInVideos(vttNaarTekst(vtt), bronnen);
      // Ook een niet-treffer bewaren we, anders proberen we het elke run opnieuw.
      await supabase
        .from('scout_finds')
        .update({ decoded: { ...decoded, bron_match: match ?? { geen_treffer: true } } })
        .eq('id', find.id);

      if (match) resultaten.push({ post_url: find.post_url, match });
    } catch {
      // Eén mislukte vondst mag de rest niet blokkeren.
    }
  }

  return NextResponse.json({ gematcht: resultaten.length, bekeken: finds?.length ?? 0, resultaten });
}
