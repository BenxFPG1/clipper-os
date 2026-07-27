import Link from 'next/link';
import { db } from '@/lib/supabase';
import { AddVideoForm } from './add-video-form';

export const dynamic = 'force-dynamic';

export default async function VideosPage() {
  const supabase = db();
  const [videos, campaigns] = await Promise.all([
    supabase
      .from('videos')
      .select('id, title, duration_seconds, transcript_source, created_at')
      .order('created_at', { ascending: false }),
    supabase.from('campaigns').select('id, name').eq('status', 'active'),
  ]);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Bronvideo&apos;s</h1>

      <AddVideoForm campaigns={campaigns.data ?? []} />

      <ul className="space-y-2">
        {(videos.data ?? []).map((v) => (
          <li key={v.id} className="rounded border border-neutral-800 px-4 py-3">
            <Link href={`/videos/${v.id}`} className="font-medium hover:underline">
              {v.title}
            </Link>
            <div className="text-sm text-neutral-400">
              {v.duration_seconds ? `${Math.round(v.duration_seconds / 60)} min` : 'duur onbekend'} ·{' '}
              {v.transcript_source}
            </div>
          </li>
        ))}
        {(videos.data ?? []).length === 0 && (
          <li className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
            Nog geen video&apos;s toegevoegd.
          </li>
        )}
      </ul>
    </div>
  );
}
