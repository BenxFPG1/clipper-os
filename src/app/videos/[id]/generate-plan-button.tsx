'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function GeneratePlanButton({
  videoId,
  hasPlan,
  hasCharacterMap,
}: {
  videoId: string;
  hasPlan: boolean;
  hasCharacterMap: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [reuse, setReuse] = useState(hasCharacterMap);

  async function generate() {
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/videos/${videoId}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reuse_character_map: reuse }),
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
        {busy ? 'Bezig (kan enkele minuten duren)…' : hasPlan ? 'Nieuwe planversie genereren' : 'Clip-plan genereren'}
      </button>

      {hasCharacterMap && (
        <label className="flex items-center gap-2 text-sm text-neutral-400">
          <input type="checkbox" checked={reuse} onChange={(e) => setReuse(e.target.checked)} />
          Bestaande character map hergebruiken (sneller, goedkoper)
        </label>
      )}

      {melding && <p className="w-full text-sm text-neutral-400">{melding}</p>}
      {error && <p className="w-full text-sm text-red-400">{error}</p>}
    </div>
  );
}
