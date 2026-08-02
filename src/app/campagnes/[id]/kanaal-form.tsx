'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { datumTijd } from '@/lib/format';

/**
 * Bronkanaal van de campagne: staat dit ingevuld, dan haalt de dagelijkse
 * cloudrun nieuwe uploads zelf binnen — met transcript en meteen een clip-plan.
 * Handmatig video's toevoegen hoeft dan niet meer.
 */
export function KanaalForm({
  campaignId,
  kanaalUrl,
  autoPlan,
  laatsteCheck,
}: {
  campaignId: string;
  kanaalUrl: string | null;
  autoPlan: boolean;
  laatsteCheck: string | null;
}) {
  const router = useRouter();
  const [url, setUrl] = useState(kanaalUrl ?? '');
  const [plan, setPlan] = useState(autoPlan);
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  async function opslaan(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMelding(null);
    const res = await fetch(`/api/campaigns/${campaignId}/kanaal`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bron_kanaal_url: url.trim() || null, auto_plan: plan }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    setMelding(res.ok ? 'Opgeslagen. De dagelijkse run haalt nieuwe uploads voortaan zelf op.' : (json.error ?? 'Opslaan mislukt'));
    router.refresh();
  }

  async function nuOphalen() {
    setBusy(true);
    setMelding(null);
    const res = await fetch(`/api/campaigns/${campaignId}/kanaal`, { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    setMelding(res.ok ? (json.melding ?? 'Ophalen gestart.') : (json.error ?? 'Ophalen mislukt'));
    router.refresh();
  }

  return (
    <form onSubmit={opslaan} className="space-y-3 rounded border border-neutral-800 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500">Bronkanaal (automatisch ophalen)</h2>
        {laatsteCheck && <span className="text-xs text-neutral-500">laatst gecheckt {datumTijd(laatsteCheck)}</span>}
      </div>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://www.youtube.com/@kanaalnaam"
        className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
      />
      <label className="flex items-center gap-2 text-sm text-neutral-400">
        <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} />
        Meteen een clip-plan maken voor elke nieuwe video
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {busy ? 'Bezig…' : 'Opslaan'}
        </button>
        {kanaalUrl && (
          <button
            type="button"
            onClick={nuOphalen}
            disabled={busy}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Nu nieuwe uploads ophalen
          </button>
        )}
        {melding && <span className="text-sm text-neutral-400">{melding}</span>}
      </div>
    </form>
  );
}
