import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase';
import { CharacterMap, ClipPlan } from '@/lib/planner/schema';
import { PlanEditor } from './plan-editor';
import { GeneratePlanButton } from './generate-plan-button';

export const dynamic = 'force-dynamic';

export default async function VideoDetailPage({ params }: { params: { id: string } }) {
  const supabase = db();

  const { data: video } = await supabase.from('videos').select('*').eq('id', params.id).single();
  if (!video) notFound();

  const { data: plans } = await supabase
    .from('clip_plans')
    .select('id, plan, prompt_version, schema_version, created_at')
    .eq('video_id', params.id)
    .order('created_at', { ascending: false });

  const latest = plans?.[0];
  const { data: clips } = latest
    ? await supabase.from('clips').select('*').eq('clip_plan_id', latest.id).order('plan_index')
    : { data: [] };

  const characterMap = video.character_map as CharacterMap | null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{video.title}</h1>
        <p className="text-sm text-neutral-400">
          {video.duration_seconds ? `${Math.round(video.duration_seconds / 60)} min` : 'duur onbekend'} ·{' '}
          {video.transcript_source} · {(video.transcript as unknown[])?.length ?? 0} segmenten
        </p>
      </div>

      <GeneratePlanButton videoId={video.id} hasPlan={Boolean(latest)} hasCharacterMap={Boolean(characterMap)} />

      {characterMap && (
        <details className="rounded border border-neutral-800 p-4">
          <summary className="cursor-pointer font-medium">Character map</summary>
          <div className="mt-4 space-y-4">
            {characterMap.personen.map((p) => (
              <div key={p.naam} className="rounded border border-neutral-800 p-3">
                <div className="font-medium">
                  {p.naam} <span className="text-sm font-normal text-neutral-400">— {p.rol}</span>
                </div>
                <p className="mt-1 text-sm text-neutral-300">{p.boog}</p>
                <p className="mt-1 text-sm italic text-neutral-400">Ironie: {p.ironie}</p>
                <ul className="mt-2 space-y-1 text-sm text-neutral-400">
                  {p.sleutelmomenten.map((m, i) => (
                    <li key={i}>
                      {formatTime(m.start)}–{formatTime(m.end)} · {m.functie} · {m.wat}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {characterMap.reveals.length > 0 && (
              <div className="rounded border border-neutral-800 p-3">
                <div className="font-medium">Reveals</div>
                <ul className="mt-2 space-y-1 text-sm text-neutral-400">
                  {characterMap.reveals.map((r, i) => (
                    <li key={i}>
                      {formatTime(r.start)} · {r.wat} (herinterpreteert{' '}
                      {r.herinterpreteert.map(formatTime).join(', ') || '—'})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}

      {latest ? (
        <PlanEditor
          plan={latest.plan as ClipPlan}
          clips={(clips ?? []) as never[]}
          promptVersion={latest.prompt_version}
          planCount={plans?.length ?? 1}
        />
      ) : (
        <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
          Nog geen clip-plan. Genereer er een hierboven.
        </p>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
