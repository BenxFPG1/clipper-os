'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Genereert verhaallijnen voor deze opdracht. Het aantal is instelbaar; elke
 * variant wordt gedwongen in een andere stijl uit de bibliotheek (max 11 —
 * zoveel stijlen zijn er).
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
  const [aantal, setAantal] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);

  async function generate() {
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
    if (json.inWachtrij) setMelding(json.melding);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={generate}
        disabled={busy}
        className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
      >
        {busy
          ? `Bezig met ${aantal} verhaallijn(en)… (±2-4 min per stuk)`
          : hasScript
            ? `${aantal} extra verhaallijn(en) genereren`
            : `${aantal} verhaallijn(en) genereren`}
      </button>
      <label className="flex items-center gap-2 text-sm text-neutral-400">
        aantal
        <input
          type="number"
          min={1}
          max={11}
          value={aantal}
          onChange={(e) => setAantal(Number(e.target.value))}
          className="w-16 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
        />
      </label>
      {versies > 0 && <span className="text-xs text-neutral-500">{versies} variant(en) bewaard</span>}
      <span className="w-full text-xs text-neutral-500">
        Elke variant is twee zware calls (bedenken + examineren) en telt mee in je Claude-limiet.
      </span>
      {melding && <p className="w-full text-sm text-neutral-400">{melding}</p>}
      {error && <p className="w-full text-sm text-red-400">{error}</p>}
    </div>
  );
}
