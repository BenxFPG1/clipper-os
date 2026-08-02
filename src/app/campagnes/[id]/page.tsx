import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase';
import { datumTijd } from '@/lib/format';
import { AddVideoForm } from '@/app/videos/add-video-form';
import { NewBriefForm } from '@/app/opdrachten/new-brief-form';
import { NameEditor } from './name-editor';
import { BatchKnoppen } from './batch-knoppen';
import { KanaalForm } from './kanaal-form';

export const dynamic = 'force-dynamic';

type Regels = {
  platforms?: string[];
  min_seconds?: number | null;
  max_eur_per_clip?: number | null;
  tags?: string[];
  hashtags?: string[];
  description_line?: string | null;
  forbidden?: string[];
  other_rules?: string[];
};

/**
 * De werkplek van één campagne: alles wat erbij hoort op één pagina —
 * bronvideo's met plan-status, opdrachten met scripts, en de regels.
 * Vanaf hier start je elke volgende stap zonder te zoeken.
 */
export default async function CampagnePage({ params }: { params: { id: string } }) {
  const supabase = db();

  const { data: campagne } = await supabase.from('campaigns').select('*').eq('id', params.id).single();
  if (!campagne) notFound();

  const [videosRes, briefsRes] = await Promise.all([
    supabase
      .from('videos')
      .select('id, title, duration_seconds, created_at, archived_at, character_map, clip_plans(id)')
      .eq('campaign_id', params.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('briefs')
      .select('id, titel, platform, status, created_at, brief_scripts(id)')
      .eq('campaign_id', params.id)
      .order('created_at', { ascending: false }),
  ]);

  const videos = (videosRes.data ?? []).filter((v) => !v.archived_at);
  const briefs = briefsRes.data ?? [];

  // Oudere campagnes hebben regels in nét andere vormen (string i.p.v. lijst);
  // alles naar lijsten dwingen zodat de pagina nooit stukgaat op oude data.
  const alsLijst = (x: unknown): string[] =>
    Array.isArray(x) ? x.map(String) : typeof x === 'string' && x.trim() ? [x] : [];
  const ruw = (campagne.platform_rules ?? {}) as Record<string, unknown>;
  const regels: Regels = {
    platforms: alsLijst(ruw.platforms),
    min_seconds: typeof ruw.min_seconds === 'number' ? ruw.min_seconds : null,
    max_eur_per_clip: typeof ruw.max_eur_per_clip === 'number' ? ruw.max_eur_per_clip : null,
    tags: alsLijst(ruw.tags),
    hashtags: alsLijst(ruw.hashtags),
    description_line: typeof ruw.description_line === 'string' ? ruw.description_line : null,
    forbidden: alsLijst(ruw.forbidden),
    other_rules: alsLijst(ruw.other_rules),
  };

  return (
    <div className="space-y-8">
      <div>
        <NameEditor campaignId={campagne.id} naam={campagne.name} />
        <p className="mt-1 text-sm text-neutral-400">
          CPM €{Number(campagne.cpm_eur).toFixed(2)} · {campagne.status} · aangemaakt{' '}
          {datumTijd(campagne.created_at)}
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Bronvideo&apos;s ({videos.length})</h2>
          <span className="text-xs text-neutral-500">automatisch ophalen → plan → project downloaden</span>
        </div>
        <KanaalForm
          campaignId={campagne.id}
          kanalen={[
            ...((campagne.bron_kanalen as string[] | null) ?? []),
            ...(campagne.bron_kanaal_url ? [campagne.bron_kanaal_url as string] : []),
          ].filter((k, i, l) => k && l.indexOf(k) === i)}
          autoPlan={campagne.auto_plan !== false}
          laatsteCheck={(campagne.laatste_kanaal_check as string | null) ?? null}
          laatsteFouten={((campagne.laatste_kanaal_fouten as string[] | null) ?? []).map(String)}
        />
        <details className="rounded border border-neutral-800 p-4">
          <summary className="cursor-pointer text-sm text-neutral-500">Zelf een video toevoegen (optioneel)</summary>
          <div className="mt-3">
            <AddVideoForm campaigns={[{ id: campagne.id, name: campagne.name }]} />
          </div>
        </details>
        <ul className="space-y-2">
          {videos.map((v) => {
            const heeftPlan = (v.clip_plans as { id: string }[] | null)?.length ?? 0;
            const heeftMap = Boolean(v.character_map);
            return (
              <li key={v.id} className="flex items-start justify-between gap-3 rounded border border-neutral-800 px-4 py-3">
                <div>
                  <Link href={`/videos/${v.id}`} className="font-medium hover:underline">
                    {v.title}
                  </Link>
                  <div className="text-sm text-neutral-400">
                    {v.duration_seconds ? `${Math.round(v.duration_seconds / 60)} min · ` : ''}
                    toegevoegd {datumTijd(v.created_at)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2 text-xs">
                  <Stap af={heeftMap} label="characters" />
                  <Stap af={heeftPlan > 0} label={heeftPlan > 1 ? `plan (${heeftPlan}×)` : 'plan'} />
                </div>
              </li>
            );
          })}
          {videos.length === 0 && (
            <li className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
              Nog geen video&apos;s in deze campagne.
            </li>
          )}
        </ul>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Opdrachten ({briefs.length})</h2>
          <span className="text-xs text-neutral-500">
            concepten laten bedenken → verhaallijnen genereren → beste kiezen
          </span>
        </div>
        <BatchKnoppen
          campaignId={campagne.id}
          briefsZonderScript={briefs
            .filter((b) => ((b.brief_scripts as { id: string }[] | null)?.length ?? 0) === 0)
            .map((b) => ({ id: b.id, titel: b.titel }))}
        />
        <details className="rounded border border-neutral-800 p-4">
          <summary className="cursor-pointer text-sm text-neutral-500">Zelf een opdracht insturen (optioneel)</summary>
          <div className="mt-3">
            <NewBriefForm campaigns={[{ id: campagne.id, name: campagne.name }]} />
          </div>
        </details>
        <ul className="space-y-2">
          {briefs.map((b) => (
            <li key={b.id} className="flex items-start justify-between gap-3 rounded border border-neutral-800 px-4 py-3">
              <div>
                <Link href={`/opdrachten/${b.id}`} className="font-medium hover:underline">
                  {b.titel}
                </Link>
                <div className="text-sm text-neutral-400">
                  {b.platform ?? 'platform onbepaald'} · {b.status} · {datumTijd(b.created_at)}
                </div>
              </div>
              <Stap af={((b.brief_scripts as { id: string }[] | null)?.length ?? 0) > 0} label="script" />
            </li>
          ))}
          {briefs.length === 0 && (
            <li className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
              Nog geen opdrachten in deze campagne.
            </li>
          )}
        </ul>
      </section>

      <section className="rounded border border-neutral-800 p-4">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500">Campagneregels</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Regel naam="Platforms" waarde={regels.platforms?.join(', ')} />
          <Regel naam="Minimale lengte" waarde={regels.min_seconds ? `${regels.min_seconds}s` : undefined} />
          <Regel
            naam="Max per clip"
            waarde={regels.max_eur_per_clip ? `€${regels.max_eur_per_clip}` : undefined}
          />
          <Regel naam="Hashtags" waarde={regels.hashtags?.join(' ')} />
          <Regel naam="Tags" waarde={regels.tags?.join(', ')} />
          <Regel naam="Beschrijvingsregel" waarde={regels.description_line ?? undefined} />
        </dl>
        {(regels.forbidden?.length ?? 0) > 0 && (
          <div className="mt-3">
            <div className="text-xs uppercase tracking-wide text-red-400/70">Verboden</div>
            <ul className="mt-1 list-inside list-disc text-sm text-neutral-300">
              {regels.forbidden!.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        )}
        {(regels.other_rules?.length ?? 0) > 0 && (
          <div className="mt-3">
            <div className="text-xs uppercase tracking-wide text-neutral-500">Overige regels</div>
            <ul className="mt-1 list-inside list-disc text-sm text-neutral-300">
              {regels.other_rules!.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function Stap({ af, label }: { af: boolean; label: string }) {
  return (
    <span
      className={`rounded border px-2 py-0.5 ${
        af ? 'border-emerald-800 text-emerald-300' : 'border-neutral-800 text-neutral-600'
      }`}
    >
      {af ? '✓' : '·'} {label}
    </span>
  );
}

function Regel({ naam, waarde }: { naam: string; waarde?: string }) {
  if (!waarde) return null;
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-500">{naam}</dt>
      <dd className="text-right">{waarde}</dd>
    </div>
  );
}
