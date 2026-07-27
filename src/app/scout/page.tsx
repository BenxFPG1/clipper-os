import { db } from '@/lib/supabase';
import { AccountsPanel } from './accounts-panel';
import { QueriesPanel } from './queries-panel';

export const dynamic = 'force-dynamic';

type Decoded = {
  hook_type?: string;
  hook_beschrijving?: string;
  structuur?: string;
  waarom_het_werkt?: string;
  overdraagbaar_naar_ons?: boolean;
};

export default async function ScoutPage() {
  const supabase = db();
  const [accounts, queries, finds, kandidaten] = await Promise.all([
    supabase.from('tracked_accounts').select('*').order('handle'),
    supabase.from('search_queries').select('*').order('created_at'),
    supabase
      .from('scout_finds')
      .select('*')
      .order('outlier_score', { ascending: false, nullsFirst: false })
      .limit(30),
    supabase.from('vault_heuristics').select('*').eq('source', 'scout_agent').order('evidence_score', { ascending: false }),
  ]);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Research</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Wat op de platforms bovengemiddeld werkt: via accounts die we volgen én via eigen zoektermen.
          Kandidaat-regels worden pas actief nadat de retro ze met onze eigen cijfers bevestigt.
        </p>
      </div>

      <QueriesPanel queries={queries.data ?? []} />

      <AccountsPanel accounts={accounts.data ?? []} />

      <section>
        <h2 className="mb-3 text-lg font-medium">Kandidaat-regels ({kandidaten.data?.length ?? 0})</h2>
        {(kandidaten.data ?? []).length === 0 ? (
          <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
            Nog geen kandidaten. Voeg accounts toe en draai de scout.
          </p>
        ) : (
          <ul className="space-y-2">
            {(kandidaten.data ?? []).map((k) => (
              <li key={k.id} className="rounded border border-neutral-800 px-4 py-2 text-sm">
                <span
                  className={`mr-2 rounded px-2 py-0.5 text-xs ${
                    k.status === 'active' ? 'bg-emerald-900/60 text-emerald-200' : 'bg-neutral-800 text-neutral-400'
                  }`}
                >
                  {k.status}
                </span>
                {k.rule}
                <span className="ml-2 text-xs text-neutral-600">bewijs {k.evidence_score}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Uitschieters bij anderen</h2>
        {(finds.data ?? []).length === 0 ? (
          <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
            Nog niets gevonden.
          </p>
        ) : (
          <div className="space-y-2">
            {(finds.data ?? []).map((f) => {
              const d = (f.decoded ?? {}) as Decoded;
              return (
                <article key={f.id} className="rounded border border-neutral-800 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <a href={f.post_url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                      {f.caption ? String(f.caption).slice(0, 70) : `@${f.handle}`}
                    </a>
                    <span className="text-sm text-neutral-400">
                      {(f.views ?? 0).toLocaleString('nl-NL')} views
                      {f.views_per_dag ? ` · ${Number(f.views_per_dag).toLocaleString('nl-NL')}/dag` : ''} ·{' '}
                      {f.outlier_score}× mediaan · {f.platform}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-neutral-600">
                    @{f.handle}
                    {f.gevonden_via ? ` · via ${String(f.gevonden_via).replace(':', ' "')}"` : ''}
                  </div>
                  {d.hook_beschrijving && (
                    <p className="mt-1 text-sm">
                      <span className="text-neutral-500">Hook: </span>
                      {d.hook_beschrijving}
                      {d.hook_type && <span className="ml-1 font-mono text-xs text-neutral-500">({d.hook_type})</span>}
                    </p>
                  )}
                  {d.structuur && (
                    <p className="text-sm">
                      <span className="text-neutral-500">Structuur: </span>
                      {d.structuur}
                    </p>
                  )}
                  {d.waarom_het_werkt && <p className="mt-1 text-sm text-neutral-400">{d.waarom_het_werkt}</p>}
                  {d.overdraagbaar_naar_ons === false && (
                    <p className="mt-1 text-xs text-neutral-600">Niet overdraagbaar naar ons materiaal.</p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
