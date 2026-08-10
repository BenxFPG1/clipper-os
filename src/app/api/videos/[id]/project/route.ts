import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { bouwPremiereXml } from '@/lib/roughcut/fcpxml';
import { Shot } from '@/lib/roughcut';
import { bouwSequences, type PlanClip } from '@/lib/roughcut/project-opbouw';

/**
 * Downloadt het Premiere/Resolve-projectbestand (FCP7 XML) voor het nieuwste
 * clip-plan van deze video: per clip een sequence met de cuts los op de
 * tijdlijn. Het bestand verwijst naar "bron.mp4" naast de .xml — de bron zelf
 * download je in volle kwaliteit met yt-dlp of via `npm run project`.
 *
 * De framerate komt uit de database (gevuld door een montage- of projectrun).
 * Zonder gemeten framerate weigeren we de download (zie fpsGemeten hieronder):
 * een verkeerd aangenomen framerate schuift alle cuts stilzwijgend op, en dat
 * bleek in de praktijk precies te lezen als "cuts volgen het script niet".
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  // Varianten staan standaard aan: ze kosten geen enkele AI-call en leveren
  // per clip drie tot vier publiceerbare versies in plaats van één.
  const metVarianten = req.nextUrl.searchParams.get('varianten') !== '0';
  const supabase = db();

  const { data: video, error } = await supabase
    .from('videos')
    .select('id, title, fps, breedte, hoogte, duration_seconds, transcript, stiltes')
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
  // Zonder gemeten framerate NIET stilzwijgend 25fps aannemen: staat de bron
  // écht op bijvoorbeeld 29,97 of 30fps, dan schuiven in Premiere alle
  // knippunten systematisch op — precies "cuts volgen het script niet" en
  // "woorden afgeknipt", over meerdere clips tegelijk, zonder dat er ergens
  // een harde fout verschijnt. De site kan zelf niet meten (geen ffmpeg op
  // serverless); dat gebeurt bij de eerste voltooide render (render-worker.ts)
  // of lokaal via `npm run project`. `?fps=25` forceert bewust een waarde
  // voor wie zeker weet dat dat klopt.
  const fpsOverride = Number(req.nextUrl.searchParams.get('fps'));
  if (!fpsGemeten && !(fpsOverride > 0)) {
    return NextResponse.json(
      {
        error:
          'De framerate van deze bronvideo is nog niet gemeten. Download dit project pas nadat er minstens één clip is gerenderd (of draai lokaal `npm run project`) — anders vallen alle knippunten in Premiere verkeerd, ook als ze in het plan kloppen. Weet je zeker wat de echte framerate is, voeg dan ?fps=<getal> toe aan de downloadlink.',
      },
      { status: 409 },
    );
  }
  const fps = fpsGemeten ? (video.fps as number) : fpsOverride;

  const veiligeTitel =
    video.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60).trim() || 'video';

  // Per clip eerst de hoofdmontage, daarna de mechanische varianten. Zo staan
  // ze in Premiere netjes bij elkaar: 01, 01b, 01c, dan 02, enzovoort.
  const sequences = bouwSequences(clips as unknown as PlanClip[], {
    metVarianten,
    videoDuur: (video.duration_seconds as number | null) ?? null,
    transcript: (video.transcript as never) ?? undefined,
    stiltes: (video.stiltes as never) ?? undefined,
  });

  const xml = bouwPremiereXml(
    veiligeTitel,
    {
      pad: 'bron.mp4',
      fps,
      breedte: (video.breedte as number | null) ?? 1920,
      hoogte: (video.hoogte as number | null) ?? 1080,
    },
    sequences,
  );

  const bestandsnaam = fpsGemeten ? `${veiligeTitel}.xml` : `${veiligeTitel} (fps handmatig ${fps} - check).xml`;

  return new NextResponse(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'content-disposition': `attachment; filename="${bestandsnaam.replace(/"/g, '')}"`,
    },
  });
}
