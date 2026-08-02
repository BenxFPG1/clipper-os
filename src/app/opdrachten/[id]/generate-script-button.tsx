'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Genereert verhaallijnen voor deze opdracht. Standaard drie varianten in
 * verschillende stijlen uit de bibliotheek, zodat er echt iets te kiezen valt.
 */
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

  async function generate(aantal: number) {
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/briefs/${briefId}/script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aantal }),
    });
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
        onClick={() => generate(3)}
        disabled={busy}
        className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
      >
        {busy ? 'Bezig (meerdere varianten, kan even duren)…' : '3 verhaallijnen genereren'}
      </button>
      <button
        onClick={() => generate(1)}
        disabled={busy}
        className="rounded border border-neutral-700 px-4 py-2 text-sm disabled:opacity-40"
      >
        {hasScript ? '1 extra variant' : '1 verhaallijn'}
      </button>
      {versies > 0 && <span className="text-xs text-neutral-500">{versies} variant(en) bewaard</span>}
      {error && <p className="w-full text-sm text-red-400">{error}</p>}
    </div>
  );
}
