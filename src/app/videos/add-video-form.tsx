'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { roepApiAan } from '@/app/api-aanroep';

export function AddVideoForm({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  const router = useRouter();
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? '');
  const [sourceUrl, setSourceUrl] = useState('');
  const [title, setTitle] = useState('');
  const [transcript, setTranscript] = useState('');
  const [forceTranscribe, setForceTranscribe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMelding(null);

    const { ok, json, fout } = await roepApiAan<{ inWachtrij?: boolean; melding?: string; video?: { id: string }; planGestart?: boolean }>('/api/videos', {
      method: 'POST',
      body: {
        campaign_id: campaignId,
        title: title || undefined,
        source_url: sourceUrl || undefined,
        transcript_text: transcript || undefined,
        force_transcribe: forceTranscribe,
      },
    });

    setBusy(false);
    if (!ok) {
      setError(fout ?? 'Toevoegen mislukt');
      return;
    }
    setSourceUrl('');
    setTranscript('');
    setTitle('');
    // Staat de video er al, dan meteen door naar zijn pagina: daar verschijnt
    // het plan en maak je de clips.
    if (json.video?.id) {
      router.push(`/videos/${json.video.id}`);
      return;
    }
    // Anders wordt eerst het transcript in de cloud gemaakt; de video
    // verschijnt dan over een paar minuten in de lijst.
    setMelding(json.melding ?? 'De video wordt opgehaald en uitgeschreven. Hij verschijnt over een paar minuten in de lijst; daarna zoekt de tool vanzelf de beste momenten.');
    router.refresh();
  }

  if (campaigns.length === 0) {
    return (
      <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
        Er is nog geen campagne om de video aan te hangen. Importeer er eerst een op de startpagina.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded border border-neutral-800 p-4">
      <label className="block text-sm">
        <span className="text-neutral-300">Link naar de video</span>
        <input
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="YouTube, Google Drive of WeTransfer"
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
        />
      </label>

      <label className="block text-sm sm:max-w-sm">
        <span className="text-neutral-400">Voor welke campagne</span>
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

      <details className="text-sm">
        <summary className="cursor-pointer text-neutral-500">Meer opties</summary>
        <div className="mt-3 space-y-3">
          <label className="block sm:max-w-sm">
            <span className="text-neutral-400">Eigen titel</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
            />
          </label>
          <label className="flex items-center gap-2 text-neutral-400">
            <input type="checkbox" checked={forceTranscribe} onChange={(e) => setForceTranscribe(e.target.checked)} />
            Niet de ondertitels van YouTube gebruiken maar zelf uitschrijven (trager, preciezere tijden)
          </label>
          <label className="block">
            <span className="text-neutral-400">Geen link? Plak het transcript (regels als &quot;0:07 tekst&quot;)</span>
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={5}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
            />
          </label>
        </div>
      </details>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {melding && <p className="text-sm text-neutral-400">{melding}</p>}

      <button
        type="submit"
        disabled={busy || (!sourceUrl && !transcript)}
        className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
      >
        {busy ? 'Bezig…' : 'Video toevoegen'}
      </button>
      <p className="text-xs text-neutral-500">Daarna zoekt de tool vanzelf de beste momenten; dat duurt een paar minuten.</p>
    </form>
  );
}
