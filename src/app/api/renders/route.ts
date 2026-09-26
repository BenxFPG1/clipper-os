import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { r2SignedUrl } from '@/lib/r2';
import { feedbackVoorRenders, startRenderCloudRun } from '@/lib/tracking/leerlus';

/** Downloadlinks blijven een uur geldig; lang genoeg om te downloaden, kort genoeg om niet te lekken. */
const LINK_GELDIG_SECONDEN = 3600;

/**
 * Renderopdrachten opvragen, inclusief verse downloadlinks voor wat klaar is.
 * De opslag staat op privé, dus we tekenen per keer een tijdelijke link.
 */
export async function GET(req: NextRequest) {
  const videoId = new URL(req.url).searchParams.get('video_id');
  const supabase = db();

  let query = supabase.from('render_jobs').select('*').order('created_at', { ascending: false }).limit(20);
  if (videoId) query = query.eq('video_id', videoId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Oordeel en post-status per bestand, voor de leerlus in het paneel.
  const feedback = await feedbackVoorRenders((data ?? []).filter((j) => j.status === 'klaar').map((j) => j.id as string)).catch(
    () => new Map(),
  );

  const jobs = await Promise.all(
    (data ?? []).map(async (job) => {
      // De worker hangt sinds de keuringsstatus en de hookvarianten extra
      // velden aan elk bestand; die gaan één-op-één door naar het paneel.
      const bestanden = (job.bestanden ?? []) as {
        naam: string;
        pad: string;
        bytes: number;
        hook_variant?: number;
        hook_tekst?: string;
        keuring?: { status?: string; goed?: boolean | null; regels?: { goed: boolean | null; naam: string; detail: string }[] };
      }[];
      if (job.status !== 'klaar' || bestanden.length === 0) return { ...job, downloads: [] };

      const downloads = await Promise.all(
        bestanden.map(async (b) => {
          const url = await r2SignedUrl(b.pad, LINK_GELDIG_SECONDEN);
          const regels = b.keuring?.regels ?? [];
          return {
            naam: b.naam,
            bytes: b.bytes,
            url,
            hook_variant: b.hook_variant ?? null,
            hook_tekst: b.hook_tekst ?? null,
            keuring_status: b.keuring?.status ?? (b.keuring ? (b.keuring.goed === false ? 'review_nodig' : 'goed') : null),
            keuring_fouten: regels.filter((r) => r.goed === false).map((r) => `${r.naam}: ${r.detail}`),
            beoordeling: feedback.get(`${job.id}|${b.naam}`)?.beoordeling ?? null,
            gepost: feedback.get(`${job.id}|${b.naam}`)?.gepost ?? null,
          };
        }),
      );
      return { ...job, downloads };
    }),
  );

  return NextResponse.json({ jobs });
}

/**
 * Zet een renderopdracht klaar. De site rendert niet zelf — dat gebeurt in de
 * cloud-workflow, die elk kwartier kijkt of er iets klaarstaat.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { video_id?: string; clip_index?: number | null; titel?: string };
  if (!body.video_id) return NextResponse.json({ error: 'video_id is verplicht' }, { status: 400 });

  const supabase = db();

  // Niet dubbel in de wachtrij zetten; dat kost onnodig rekentijd. Wel per
  // clip: clip 3 aanvragen terwijl clip 1 rendert is geen dubbele. En met
  // limit(1) in plaats van maybeSingle(), want die laatste gaf bij twee
  // lopende jobs een fout terug en liet de dubbele juist wél door.
  const clipIndex = body.clip_index ?? null;
  let dedupe = supabase
    .from('render_jobs')
    .select('id, status')
    .eq('video_id', body.video_id)
    .in('status', ['wachtend', 'bezig']);
  dedupe = clipIndex === null ? dedupe.is('clip_index', null) : dedupe.eq('clip_index', clipIndex);
  const { data: bestaandeJobs } = await dedupe.limit(1);
  const bestaand = bestaandeJobs?.[0];
  if (bestaand) {
    return NextResponse.json({
      job: bestaand,
      melding:
        clipIndex === null
          ? 'Er staat al een montage van alle clips klaar of in de maak.'
          : `Er staat al een montage van clip ${clipIndex} klaar of in de maak.`,
    });
  }

  const { data, error } = await supabase
    .from('render_jobs')
    .insert({
      video_id: body.video_id,
      clip_index: body.clip_index ?? null,
      titel: body.titel ?? null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const directGestart = await startRenderCloudRun();
  return NextResponse.json({ job: data, direct_gestart: directGestart });
}
