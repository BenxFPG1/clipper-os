import Link from 'next/link';
import { db } from '@/lib/supabase';
import { datumTijd } from '@/lib/format';
import { AddVideoForm } from './add-video-form';
import { ArchiveButton } from './archive-button';

export const dynamic = 'force-dynamic';

type VideoRij = {
  id: string;
  title: string;
  duration_seconds: number | null;
  transcript_source: string | null;
  created_at: string;
  archived_at: string | null;
};

export default async function VideosPage() {
  const supabase = db();
  const [videos, campaigns] = await Promise.all([
    supabase
      .from('videos')
      .select('id, title, duration_seconds, transcript_source, created_at, archived_at')
      .order('created_at', { ascending: false }),
    supabase.from('campaigns').select('id, name').eq('status', 'active'),
  ]);

  const alle = (videos.data ?? []) as VideoRij[];
  const actief = alle.filter((v) => !v.archived_at);
  const archief = alle.filter((v) => v.archived_at);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Bronvideo&apos;s</h1>

      <AddVideoForm campaigns={campaigns.data ?? []} />

      <ul className="space-y-2">
        {actief.map((v) => (
          <li key={v.id} className="flex items-start justify-between gap-3 rounded border border-neutral-800 px-4 py-3">
            <div>
              <Link href={`/videos/${v.id}`} className="font-medium hover:underline">
                {v.title}
              </Link>
              <div className="text-sm text-neutral-400">
                {v.duration_seconds ? `${Math.round(v.duration_seconds / 60)} min` : 'duur onbekend'} ·{' '}
                {v.transcript_source} · toegevoegd {datumTijd(v.created_at)}
              </div>
            </div>
            <ArchiveButton videoId={v.id} gearchiveerd={false} />
          </li>
        ))}
        {actief.length === 0 && (
          <li className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
            Nog geen video&apos;s toegevoegd.
          </li>
        )}
      </ul>

      {archief.length > 0 && (
        <details className="rounded border border-neutral-800 p-4">
          <summary className="cursor-pointer text-sm uppercase tracking-wide text-neutral-500">
            Archief ({archief.length})
          </summary>
          <ul className="mt-3 space-y-2">
            {archief.map((v) => (
              <li
                key={v.id}
                className="flex items-start justify-between gap-3 rounded border border-neutral-800 px-4 py-3 opacity-60"
              >
                <div>
                  <Link href={`/videos/${v.id}`} className="font-medium hover:underline">
                    {v.title}
                  </Link>
                  <div className="text-sm text-neutral-400">
                    toegevoegd {datumTijd(v.created_at)} · gearchiveerd {datumTijd(v.archived_at)}
                  </div>
                </div>
                <ArchiveButton videoId={v.id} gearchiveerd={true} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
