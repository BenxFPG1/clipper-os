import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase';
import { datumTijd } from '@/lib/format';
import { CharacterMap, ClipPlan } from '@/lib/planner/schema';
import { PlanEditor } from './plan-editor';
import { GeneratePlanButton } from './generate-plan-button';
import { RenderPanel } from './render-panel';
import { ArchiveButton } from '../archive-button';
import { BronDownloaden } from './bron-downloaden';

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
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{video.title}</h1>
          <p className="text-sm text-neutral-400">
            {video.duration_seconds ? `${Math.round(video.duration_seconds / 60)} min` : 'duur onbekend'} ·{' '}
            {video.transcript_source} · {(video.transcript as unknown[])?.length ?? 0} segmenten · toegevoegd{' '}
            {datumTijd(video.created_at)}
            {video.archived_at ? ` · gearchiveerd ${datumTijd(video.archived_at)}` : ''}
          </p>
        </div>
        <ArchiveButton videoId={video.id} gearchiveerd={Boolean(video.archived_at)} naArchiveren="/videos" />
      </div>

      <GeneratePlanButton videoId={video.id} hasPlan={Boolean(latest)} hasCharacterMap={Boolean(characterMap)} />

      {latest && (
        <div className="rounded border border-neutral-800 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={`/api/videos/${video.id}/project`}
              className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
              download
            >
              Premiere-project downloaden ({(latest.plan as ClipPlan).clips.length} clips + varianten)
            </a>
            <span className="text-sm text-neutral-400">
              Klaar in een seconde — de cuts staan op V2, met V1 vrij voor je eigen laag.
            </span>
            <a
              href={`/api/videos/${video.id}/project?varianten=0`}
              className="text-xs text-neutral-500 hover:text-neutral-300"
              download
            >
              alleen de hoofdmontages
            </a>
          </div>
          <p className="mt-2 text-sm text-neutral-500">
            Elke clip is een eigen sequence met de knippen los op de tijdlijn, dus je verschuift ze zonder opnieuw
            te renderen. Per clip zitten er gratis varianten bij — kort skelet, ander instappunt, en een part
            1/part 2-knip — dus uit één plan komen drie tot vier keer zoveel posts.
            {!video.fps &&
              ' Let op: de framerate is nog niet gemeten, dus het project gaat uit van 25 fps — draai npm run project voor zekerheid.'}
          </p>

          <div className="mt-3 rounded bg-neutral-900/60 px-3 py-2 text-xs text-neutral-400">
            <span className="text-neutral-300">Openen in Premiere:</span> File → Import (Cmd+I) → kies de .xml.
            Alle sequences verschijnen in een eigen bin. Begin bij{' '}
            <span className="text-neutral-300">00 - BRON met knippunten</span>: daar staat de hele video met een
            marker op elk knippunt (welke clip, welke functie, wat de bedoeling is). De genummerde sequences
            eronder zijn diezelfde knippen al gemaakt. Verticaal maken gaat het snelst met Sequence → Auto
            Reframe Sequence → 9:16; die volgt de spreker in beeld.
          </div>

          <div className="mt-4 border-t border-neutral-800 pt-3">
            <h3 className="mb-2 text-sm uppercase tracking-wide text-neutral-500">Bronbestand erbij halen</h3>
            <BronDownloaden videoId={video.id} sourceUrl={video.source_url as string | null} />
          </div>
        </div>
      )}

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

      {latest && (
        <details className="rounded border border-neutral-800 p-4">
          <summary className="cursor-pointer text-sm text-neutral-500">
            Liever kant-en-klare mp4&apos;s? (trager: renderen in de cloud)
          </summary>
          <div className="mt-3">
            <RenderPanel videoId={params.id} aantalClips={(latest.plan as ClipPlan).clips.length} />
          </div>
        </details>
      )}

      {latest && (
        <p className="text-sm text-neutral-500">
          Nieuwste plan gegenereerd op {datumTijd(latest.created_at)} ({latest.prompt_version})
          {plans && plans.length > 1 ? ` · ${plans.length} versies` : ''}
        </p>
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
