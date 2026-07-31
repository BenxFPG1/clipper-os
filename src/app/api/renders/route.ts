import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

const BUCKET = 'montages';
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

  const jobs = await Promise.all(
    (data ?? []).map(async (job) => {
      const bestanden = (job.bestanden ?? []) as { naam: string; pad: string; bytes: number }[];
      if (job.status !== 'klaar' || bestanden.length === 0) return { ...job, downloads: [] };

      const downloads = await Promise.all(
        bestanden.map(async (b) => {
          const { data: link } = await supabase.storage.from(BUCKET).createSignedUrl(b.pad, LINK_GELDIG_SECONDEN);
          return { naam: b.naam, bytes: b.bytes, url: link?.signedUrl ?? null };
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

  // Niet dubbel in de wachtrij zetten; dat kost onnodig rekentijd.
  const { data: bestaand } = await supabase
    .from('render_jobs')
    .select('id, status')
    .eq('video_id', body.video_id)
    .in('status', ['wachtend', 'bezig'])
    .maybeSingle();
  if (bestaand) {
    return NextResponse.json({ job: bestaand, melding: 'Er staat al een montage klaar of in de maak.' });
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
  return NextResponse.json({ job: data });
}
