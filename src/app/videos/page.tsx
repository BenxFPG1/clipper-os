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
  const [videos, campaigns, plannen, renders, planJobs] = await Promise.all([
    supabase
      .from('videos')
      .select('id, title, duration_seconds, transcript_source, created_at, archived_at')
      .order('created_at', { ascending: false }),
    supabase.from('campaigns').select('id, name').eq('status', 'active'),
    supabase.from('clip_plans').select('video_id'),
    supabase.from('render_jobs').select('video_id, status'),
    supabase.from('ai_jobs').select('doel_id').eq('soort', 'clip_plan').in('status', ['wachtend', 'bezig']),
  ]);

  // Waar staat elke video in de route? Dat is wat je in de lijst wilt zien,
  // niet welke transcriptie hij heeft.
  const metPlan = new Set((plannen.data ?? []).map((p) => p.video_id as string));
  const planLoopt = new Set((planJobs.data ?? []).map((j) => j.doel_id as string));
  const clipsKlaar = new Map<string, number>();
  const clipsBezig = new Set<string>();
  for (const r of renders.data ?? []) {
    if (r.status === 'klaar') clipsKlaar.set(r.video_id as string, (clipsKlaar.get(r.video_id as string) ?? 0) + 1);
    if (r.status === 'wachtend' || r.status === 'bezig') clipsBezig.add(r.video_id as string);
  }
  const stand = (id: string): { tekst: string; klasse: string } => {
    if (clipsBezig.has(id)) return { tekst: 'clips worden gemaakt', klasse: 'bg-sky-900/60 text-sky-200' };
    if (clipsKlaar.has(id)) return { tekst: `${clipsKlaar.get(id)}× clips gemaakt`, klasse: 'bg-emerald-900/60 text-emerald-200' };
    if (metPlan.has(id)) return { tekst: 'plan klaar: kies je clips', klasse: 'bg-amber-900/60 text-amber-200' };
    if (planLoopt.has(id)) return { tekst: 'zoekt de beste momenten', klasse: 'bg-sky-900/60 text-sky-200' };
    return { tekst: 'nog geen plan', klasse: 'bg-neutral-800 text-neutral-400' };
  };

  const alle = (videos.data ?? []) as VideoRij[];
  const actief = alle.filter((v) => !v.archived_at);
  const archief = alle.filter((v) => v.archived_at);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Video&apos;s</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Voeg een lange video toe; de tool zoekt de beste momenten en maakt er clips van. Klik op een video om de
          clips te kiezen en te bekijken.
        </p>
      </div>

      <AddVideoForm campaigns={campaigns.data ?? []} />

      <ul className="space-y-2">
        {actief.map((v) => (
          <li key={v.id} className="flex items-start justify-between gap-3 rounded border border-neutral-800 px-4 py-3">
            <div>
              <Link href={`/videos/${v.id}`} className="font-medium hover:underline">
                {v.title}
              </Link>
              <div className="mt-0.5 text-sm text-neutral-400">
                <span className={`mr-2 rounded px-1.5 py-0.5 text-xs ${stand(v.id).klasse}`}>{stand(v.id).tekst}</span>
                {v.duration_seconds ? `${Math.max(1, Math.round(v.duration_seconds / 60))} min` : 'duur onbekend'} · toegevoegd{' '}
                {datumTijd(v.created_at)}
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
