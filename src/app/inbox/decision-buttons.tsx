'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function DecisionButtons({ runId, hasChanges }: { runId: string; hasChanges: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/agents/runs/${runId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    const json = await res.json();

    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? 'Beslissing verwerken mislukt');
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => decide('approve')}
        disabled={busy || !hasChanges}
        className="rounded bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-40"
      >
        Goedkeuren
      </button>
      <button
        onClick={() => decide('reject')}
        disabled={busy}
        className="rounded border border-neutral-700 px-4 py-2 text-sm disabled:opacity-40"
      >
        Afwijzen
      </button>
      {error && <span className="text-sm text-red-400">{error}</span>}
    </div>
  );
}
