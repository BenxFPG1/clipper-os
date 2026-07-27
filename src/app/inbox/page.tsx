import { db } from '@/lib/supabase';
import { DecisionButtons } from './decision-buttons';

export const dynamic = 'force-dynamic';

type Wijziging = {
  entity: string;
  slug: string;
  huidig_gewicht: number;
  nieuw_gewicht: number;
  reden: string;
  bewijs_clip_ids: string[];
};

export default async function InboxPage() {
  const { data: runs } = await db()
    .from('agent_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  const pending = (runs ?? []).filter((r) => r.status === 'pending');
  const decided = (runs ?? []).filter((r) => r.status !== 'pending');

  return (
    <div className="space-y-10">
      <h1 className="text-2xl font-semibold">Agent-inbox</h1>

      <section>
        <h2 className="mb-3 text-lg font-medium">Wacht op jouw beslissing</h2>
        {pending.length === 0 ? (
          <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
            Geen openstaande voorstellen.
          </p>
        ) : (
          <div className="space-y-4">
            {pending.map((run) => {
              const proposal = run.proposal as { samenvatting: string; wijzigingen: Wijziging[] };
              return (
                <article key={run.id} className="rounded border border-neutral-800 p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{run.agent}-agent</span>
                    <span className="text-xs text-neutral-500">
                      {new Date(run.created_at).toLocaleString('nl-NL')}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-neutral-300">{proposal.samenvatting}</p>

                  {proposal.wijzigingen.length > 0 ? (
                    <ul className="mt-3 space-y-2">
                      {proposal.wijzigingen.map((w, i) => (
                        <li key={i} className="rounded border border-neutral-800 px-3 py-2 text-sm">
                          <div>
                            <span className="font-mono text-xs text-neutral-500">
                              {w.entity}/{w.slug}
                            </span>{' '}
                            {w.huidig_gewicht.toFixed(2)} →{' '}
                            <span className="font-medium">{w.nieuw_gewicht.toFixed(2)}</span>
                          </div>
                          <div className="text-neutral-400">{w.reden}</div>
                          <div className="text-xs text-neutral-600">
                            Bewijs: {w.bewijs_clip_ids.length} clips
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-sm text-neutral-500">Geen wijzigingen voorgesteld.</p>
                  )}

                  <div className="mt-4">
                    <DecisionButtons runId={run.id} hasChanges={proposal.wijzigingen.length > 0} />
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Historie</h2>
        <ul className="space-y-1 text-sm">
          {decided.map((run) => (
            <li key={run.id} className="rounded border border-neutral-800 px-4 py-2">
              <span className="text-neutral-400">{run.agent}</span> ·{' '}
              <span
                className={
                  run.status === 'approved' ? 'text-emerald-300' : run.status === 'rejected' ? 'text-red-300' : ''
                }
              >
                {run.status}
              </span>{' '}
              <span className="text-xs text-neutral-600">
                {run.decided_at ? new Date(run.decided_at).toLocaleString('nl-NL') : ''}
              </span>
            </li>
          ))}
          {decided.length === 0 && <li className="text-neutral-500">Nog niets besloten.</li>}
        </ul>
      </section>
    </div>
  );
}
