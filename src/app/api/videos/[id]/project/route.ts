import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { bouwPremiereXml } from '@/lib/roughcut/fcpxml';
import { Shot } from '@/lib/roughcut';

/**
 * Downloadt het Premiere/Resolve-projectbestand (FCP7 XML) voor het nieuwste
 * clip-plan van deze video: per clip een sequence met de cuts los op de
 * tijdlijn. Het bestand verwijst naar "bron.mp4" naast de .xml — de bron zelf
 * download je in volle kwaliteit met yt-dlp of via `npm run project`.
 *
 * De framerate komt uit de database (gevuld door een montage- of projectrun).
 * Zonder gemeten framerate gebruiken we 25 fps en melden dat in de bestandsnaam,
 * want een verkeerde framerate schuift alle cuts op.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = db();

  const { data: video, error } = await supabase
    .from('videos')
    .select('id, title, fps, breedte, hoogte')
    .eq('id', params.id)
    .single();
  if (error || !video) {
    return NextResponse.json({ error: 'Video niet gevonden' }, { status: 404 });
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
    shots: Shot[];
  }[];
  if (clips.length === 0) {
    return NextResponse.json({ error: 'Geen clip-plan voor deze video' }, { status: 404 });
  }

  const fpsGemeten = typeof video.fps === 'number' && video.fps > 0;
  const fps = fpsGemeten ? (video.fps as number) : 25;

  const veiligeTitel =
    video.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60).trim() || 'video';

  const xml = bouwPremiereXml(
    veiligeTitel,
    {
      pad: 'bron.mp4',
      fps,
      breedte: (video.breedte as number | null) ?? 1920,
      hoogte: (video.hoogte as number | null) ?? 1080,
    },
    clips.map((c, i) => ({ nummer: i + 1, titel: c.titel_intern, shots: c.shots })),
  );

  const bestandsnaam = fpsGemeten
    ? `${veiligeTitel}.xml`
    : `${veiligeTitel} (fps aangenomen 25 - check).xml`;

  return new NextResponse(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'content-disposition': `attachment; filename="${bestandsnaam.replace(/"/g, '')}"`,
    },
  });
}
