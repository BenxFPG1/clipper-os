'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function AddVideoForm({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  const router = useRouter();
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? '');
  const [sourceUrl, setSourceUrl] = useState('');
  const [title, setTitle] = useState('');
  const [transcript, setTranscript] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch('/api/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        campaign_id: campaignId,
        title: title || undefined,
        source_url: sourceUrl || undefined,
        transcript_text: transcript || undefined,
      }),
    });

    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? 'Toevoegen mislukt');
      return;
    }
    setSourceUrl('');
    setTranscript('');
    setTitle('');
    router.refresh();
  }

  if (campaigns.length === 0) {
    return (
      <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
        Maak eerst een campagne aan (`npm run seed`).
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded border border-neutral-800 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-neutral-400">Campagne</span>
          <select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          >
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-neutral-400">Titel (optioneel)</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          />
        </label>
      </div>

      <label className="block text-sm">
        <span className="text-neutral-400">YouTube-URL</span>
        <input
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=..."
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
        />
      </label>

      <label className="block text-sm">
        <span className="text-neutral-400">Of plak het transcript (regels als &quot;0:07 tekst&quot;)</span>
        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          rows={6}
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
        />
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={busy || (!sourceUrl && !transcript)}
        className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
      >
        {busy ? 'Bezig…' : 'Video toevoegen'}
      </button>
    </form>
  );
}
