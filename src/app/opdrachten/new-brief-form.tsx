'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function NewBriefForm({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  const router = useRouter();
  const [titel, setTitel] = useState('');
  const [briefing, setBriefing] = useState('');
  const [doel, setDoel] = useState('');
  const [platform, setPlatform] = useState('tiktok');
  const [duur, setDuur] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch('/api/briefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        titel,
        briefing,
        doel: doel || undefined,
        platform,
        duur_seconden: duur ? Number(duur) : undefined,
        campaign_id: campaignId || undefined,
      }),
    });
    const json = await res.json();

    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? 'Opslaan mislukt');
      return;
    }
    router.push(`/opdrachten/${json.brief.id}`);
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded border border-neutral-800 p-4">
      <label className="block text-sm">
        <span className="text-neutral-400">Titel</span>
        <input
          value={titel}
          onChange={(e) => setTitel(e.target.value)}
          placeholder="bv. Promo nieuwe aflevering"
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
        />
      </label>

      <label className="block text-sm">
        <span className="text-neutral-400">Briefing</span>
        <textarea
          value={briefing}
          onChange={(e) => setBriefing(e.target.value)}
          rows={6}
          placeholder="Wat moet er gemaakt worden, voor wie, wat is de boodschap, wat heb je aan materiaal, wat mag absoluut niet?"
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-sm">
          <span className="text-neutral-400">Doel</span>
          <input
            value={doel}
            onChange={(e) => setDoel(e.target.value)}
            placeholder="views / comments"
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="text-neutral-400">Platform</span>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          >
            <option value="tiktok">TikTok</option>
            <option value="reels">Reels</option>
            <option value="shorts">Shorts</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="text-neutral-400">Duur (sec)</span>
          <input
            value={duur}
            onChange={(e) => setDuur(e.target.value.replace(/\D/g, ''))}
            placeholder="30"
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="text-neutral-400">Campagne</span>
          <select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          >
            <option value="">geen</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={busy || !titel.trim() || !briefing.trim()}
        className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
      >
        {busy ? 'Bezig…' : 'Opdracht aanmaken'}
      </button>
    </form>
  );
}
