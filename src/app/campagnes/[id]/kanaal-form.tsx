'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { datumTijd } from '@/lib/format';

/**
 * Bronkanalen van de campagne. Meerdere bronnen kunnen: een hoofdkanaal, een
 * shorts-kanaal, een tweede programma of een losse playlist. De dagelijkse
 * cloudrun loopt ze allemaal langs, haalt nieuwe uploads op met transcript en
 * zet er meteen een clip-plan op.
 */
export function KanaalForm({
  campaignId,
  kanalen,
  autoPlan,
  laatsteCheck,
  laatsteFouten,
}: {
  campaignId: string;
  kanalen: string[];
  autoPlan: boolean;
  laatsteCheck: string | null;
  laatsteFouten: string[];
}) {
  const router = useRouter();
  const [lijst, setLijst] = useState<string[]>(kanalen.length ? kanalen : ['']);
  const [plan, setPlan] = useState(autoPlan);
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);
  const [fouten, setFouten] = useState<string[]>([]);

  function wijzig(i: number, waarde: string) {
    setLijst((l) => l.map((k, n) => (n === i ? waarde : k)));
  }

  async function opslaan(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMelding(null);
    const schoon = lijst.map((k) => k.trim()).filter(Boolean);
    const res = await fetch(`/api/campaigns/${campaignId}/kanaal`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bron_kanalen: schoon, auto_plan: plan }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMelding(json.error ?? 'Opslaan mislukt');
      return;
    }
    setLijst(schoon.length ? schoon : ['']);
    setMelding(
      schoon.length
        ? `${schoon.length} bron(nen) opgeslagen. De dagelijkse run haalt nieuwe uploads voortaan zelf op.`
        : 'Bronnen leeggemaakt.',
    );
    router.refresh();
  }

  async function nuOphalen() {
    setBusy(true);
    setMelding(null);
    const res = await fetch(`/api/campaigns/${campaignId}/kanaal`, { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    setMelding(res.ok ? (json.melding ?? 'Ophalen gestart.') : (json.error ?? 'Ophalen mislukt'));
    // De problemen uit dit antwoord direct tonen: eerder stond er alleen
    // "4 probleem(en) — zie hieronder" zonder dat er iets onder stond.
    setFouten(Array.isArray(json.fouten) ? json.fouten : []);
    router.refresh();
  }

  return (
    <form onSubmit={opslaan} className="space-y-3 rounded border border-neutral-800 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500">Bronnen (automatisch ophalen)</h2>
        {laatsteCheck && <span className="text-xs text-neutral-500">laatst gecheckt {datumTijd(laatsteCheck)}</span>}
      </div>

      <div className="space-y-2">
        {lijst.map((kanaal, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={kanaal}
              onChange={(e) => wijzig(i, e.target.value)}
              placeholder="https://www.youtube.com/@kanaalnaam (of een playlist-URL)"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
            />
            {lijst.length > 1 && (
              <button
                type="button"
                onClick={() => setLijst((l) => l.filter((_, n) => n !== i))}
                className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
                title="Bron verwijderen"
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setLijst((l) => [...l, ''])}
          className="text-sm text-neutral-400 hover:text-neutral-200"
        >
          + nog een bron
        </button>
      </div>

      {(fouten.length > 0 || laatsteFouten.length > 0) && (
        <div className="rounded border border-amber-900/60 bg-amber-950/20 p-3">
          <div className="text-xs uppercase tracking-wide text-amber-400/80">
            Bij de laatste check ging dit mis
          </div>
          <ul className="mt-1 space-y-0.5 text-sm text-neutral-300">
            {(fouten.length > 0 ? fouten : laatsteFouten).map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}

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
        {kanalen.length > 0 && (
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
