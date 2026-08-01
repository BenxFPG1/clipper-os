'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Feedback op deze scriptversie. Gaat mee in elke volgende generatie voor deze
 * opdracht, zodat een correctie maar één keer gegeven hoeft te worden.
 */
export function FeedbackForm({
  briefId,
  scriptId,
  bestaande,
}: {
  briefId: string;
  scriptId: string;
  bestaande: string | null;
}) {
  const router = useRouter();
  const [tekst, setTekst] = useState(bestaande ?? '');
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  async function verstuur(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMelding(null);
    const res = await fetch(`/api/briefs/${briefId}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptId, feedback: tekst }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMelding(json.error ?? 'Opslaan mislukt');
      return;
    }
    setMelding('Bewaard. Dit gaat mee in de volgende scriptversie.');
    router.refresh();
  }

  return (
    <form onSubmit={verstuur} className="space-y-2 rounded border border-neutral-800 p-4">
      <h2 className="text-sm uppercase tracking-wide text-neutral-500">Jouw feedback op deze versie</h2>
      <textarea
        value={tekst}
        onChange={(e) => setTekst(e.target.value)}
        rows={3}
        placeholder='Bijvoorbeeld: "geen storyline — de shots zijn los zand, de payoff lost de hook niet in"'
        className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !tekst.trim()}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {busy ? 'Bezig…' : 'Feedback opslaan'}
        </button>
        {melding && <span className="text-sm text-neutral-400">{melding}</span>}
      </div>
    </form>
  );
}
