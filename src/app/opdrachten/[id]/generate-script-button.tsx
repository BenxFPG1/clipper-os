'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function GenerateScriptButton({
  briefId,
  hasScript,
  versies,
}: {
  briefId: string;
  hasScript: boolean;
  versies: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/briefs/${briefId}/script`, { method: 'POST' });
    const json = await res.json();

    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? 'Genereren mislukt');
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={generate}
        disabled={busy}
        className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
      >
        {busy ? 'Bezig (kan even duren)…' : hasScript ? 'Nieuwe scriptversie' : 'Script genereren'}
      </button>
      {versies > 0 && <span className="text-xs text-neutral-500">{versies} versie(s) bewaard</span>}
      {error && <p className="w-full text-sm text-red-400">{error}</p>}
    </div>
  );
}
