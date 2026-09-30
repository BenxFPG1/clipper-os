import { db } from '@/lib/supabase';
import { DecisionButtons } from './decision-buttons';
import { VerouderdKnop } from './verouderd-knop';

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
  const pendingRetro = pending.filter((r) => r.agent === 'retro').length;

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
            {pendingRetro > 1 && <VerouderdKnop aantal={pendingRetro - 1} />}
            {pending.map((run, index) => {
              const proposal = (run.proposal ?? {}) as {
                samenvatting?: string;
                wijzigingen?: Wijziging[];
                heuristiek_activaties?: { id: string; reden: string }[];
              };
              const wijzigingen = proposal.wijzigingen ?? [];
              const activaties = proposal.heuristiek_activaties ?? [];
              const telling = [
                wijzigingen.length ? `${wijzigingen.length} gewichtswijziging${wijzigingen.length === 1 ? '' : 'en'}` : null,
                activaties.length ? `${activaties.length} regelactivatie${activaties.length === 1 ? '' : 's'}` : null,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <article key={run.id} className="rounded border border-neutral-800 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {run.agent}-agent
                      {index === 0 && pending.length > 1 && (
                        <span className="ml-2 rounded bg-emerald-900/60 px-1.5 py-0.5 text-[11px] text-emerald-200">nieuwste</span>
                      )}
                    </span>
                    <span className="text-xs text-neutral-500">{new Date(run.created_at).toLocaleString('nl-NL')}</span>
                  </div>
                  <p className="mt-2 text-sm text-neutral-200">{eersteZin(proposal.samenvatting ?? '')}</p>
                  {telling && <p className="mt-1 text-xs text-neutral-500">{telling}</p>}

                  <div className="mt-3">
                    <DecisionButtons runId={run.id} hasChanges={wijzigingen.length + activaties.length > 0} />
                  </div>

                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-neutral-400 hover:text-neutral-200">Details</summary>
                    <p className="mt-2 text-sm text-neutral-300">{proposal.samenvatting}</p>
                    {wijzigingen.length > 0 ? (
                      <ul className="mt-3 space-y-2">
                        {wijzigingen.map((w, i) => (
                          <li key={i} className="rounded border border-neutral-800 px-3 py-2 text-sm">
                            <div>
                              <span className="font-mono text-xs text-neutral-500">
                                {w.entity}/{w.slug}
                              </span>{' '}
                              {w.huidig_gewicht.toFixed(2)} → <span className="font-medium">{w.nieuw_gewicht.toFixed(2)}</span>
                            </div>
                            <div className="text-neutral-400">{w.reden}</div>
                            <div className="text-xs text-neutral-600">Bewijs: {w.bewijs_clip_ids.length} clips</div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-3 text-sm text-neutral-500">Geen gewichtswijzigingen voorgesteld.</p>
                    )}
                    {activaties.length > 0 && (
                      <ul className="mt-3 space-y-2">
                        {activaties.map((a) => (
                          <li key={a.id} className="rounded border border-neutral-800 px-3 py-2 text-sm text-neutral-400">
                            Regel activeren: {a.reden}
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
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

/** De eerste zin van een samenvatting, als kop boven een voorstel. */
function eersteZin(tekst: string): string {
  const zin = tekst.match(/^.+?[.!?](\s|$)/)?.[0]?.trim() ?? tekst;
  return zin.length > 220 ? `${zin.slice(0, 217)}…` : zin;
}
