import { db } from '@/lib/supabase';
import { AccountsPanel } from './accounts-panel';
import { QueriesPanel } from './queries-panel';
import { ThemesPanel } from './themes-panel';

export const dynamic = 'force-dynamic';

export default async function ScoutPage() {
  const supabase = db();
  const [accounts, queries, themes, kandidaten] = await Promise.all([
    supabase.from('tracked_accounts').select('*').order('handle'),
    supabase.from('search_queries').select('*').order('created_at'),
    supabase.from('themes').select('*').order('name'),
    supabase.from('vault_heuristics').select('*').eq('source', 'scout_agent').order('evidence_score', { ascending: false }),
  ]);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Research</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Hier stel je in wáár de tool kijkt. Het zoeken zelf gaat automatisch: hij vindt accounts, meet hun normale
          niveau, en herkent zo wat er bovenuit steekt. Alle kennis wordt bewaard — per thema én algemeen. De vondsten
          zelf staan op <a href="/outliers" className="underline">Outliers</a>.
        </p>
      </div>

      <ThemesPanel themes={themes.data ?? []} />

      <QueriesPanel queries={queries.data ?? []} />

      <AccountsPanel accounts={accounts.data ?? []} />

      <section>
        <h2 className="mb-3 text-lg font-medium">Kandidaat-regels ({kandidaten.data?.length ?? 0})</h2>
        {(kandidaten.data ?? []).length === 0 ? (
          <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
            Nog geen kandidaten. Die ontstaan zodra de scout genoeg vondsten heeft gedecodeerd.
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

    </div>
  );
}
