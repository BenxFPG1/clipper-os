import { db } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export default async function VaultPage() {
  const supabase = db();
  const [structures, hooks, heuristics, changelog] = await Promise.all([
    supabase.from('vault_structures').select('*').order('weight', { ascending: false }),
    supabase.from('vault_hooks').select('*').order('weight', { ascending: false }),
    supabase.from('vault_heuristics').select('*').order('status'),
    supabase.from('vault_changelog').select('*').order('created_at', { ascending: false }).limit(25),
  ]);

  return (
    <div className="space-y-10">
      <h1 className="text-2xl font-semibold">Vault</h1>

      <section>
        <h2 className="mb-3 text-lg font-medium">Structuren</h2>
        <div className="space-y-2">
          {(structures.data ?? []).map((s) => (
            <div key={s.slug} className="rounded border border-neutral-800 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{s.name}</span>
                <WeightBadge weight={Number(s.weight)} version={s.version} />
              </div>
              <p className="mt-1 text-sm text-neutral-400">{s.description}</p>
              <p className="mt-1 font-mono text-xs text-neutral-500">{(s.template as string[]).join(' → ')}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Hooks</h2>
        <div className="space-y-2">
          {(hooks.data ?? []).map((h) => (
            <div key={h.slug} className="rounded border border-neutral-800 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm">{h.slug}</span>
                <WeightBadge weight={Number(h.weight)} version={h.version} />
              </div>
              <p className="mt-1 text-sm text-neutral-400">{h.formula}</p>
              {h.example && <p className="mt-1 text-sm italic text-neutral-500">&ldquo;{h.example}&rdquo;</p>}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Craft-regels</h2>
        <ul className="space-y-1">
          {(heuristics.data ?? []).map((h) => (
            <li key={h.id} className="rounded border border-neutral-800 px-4 py-2 text-sm">
              <span
                className={`mr-2 rounded px-2 py-0.5 text-xs ${
                  h.status === 'active' ? 'bg-emerald-900/60 text-emerald-200' : 'bg-neutral-800 text-neutral-400'
                }`}
              >
                {h.status}
              </span>
              {h.rule}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Changelog</h2>
        {(changelog.data ?? []).length === 0 ? (
          <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
            Nog geen wijzigingen. De Retro-agent vult dit vanaf de eerste goedkeuring.
          </p>
        ) : (
          <ul className="space-y-2">
            {(changelog.data ?? []).map((c) => (
              <li key={c.id} className="rounded border border-neutral-800 px-4 py-2 text-sm">
                <div>
                  <span className="font-mono text-xs text-neutral-500">{c.entity}/{c.entity_key}</span>{' '}
                  {String(c.old_value)} → <span className="font-medium">{String(c.new_value)}</span>
                </div>
                <div className="text-neutral-400">{c.reason}</div>
                <div className="text-xs text-neutral-600">
                  {new Date(c.created_at).toLocaleString('nl-NL')} · {c.decided_by}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function WeightBadge({ weight, version }: { weight: number; version: number }) {
  return (
    <span className="text-sm text-neutral-400">
      gewicht <span className="font-medium text-neutral-100">{weight.toFixed(2)}</span> · v{version}
    </span>
  );
}
