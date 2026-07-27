'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type SearchQuery = {
  id: string;
  query: string;
  platform: string;
  actief: boolean;
};

/**
 * Zoektermen waarmee de scout zelf op de platforms zoekt (het Sandcastles-idee).
 * Shorts werkt zonder scraping-key via yt-dlp; TikTok en Reels hebben de
 * ScrapeCreators-key nodig.
 */
export function QueriesPanel({ queries }: { queries: SearchQuery[] }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('shorts');
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMelding(null);
    const res = await fetch('/api/search-queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, platform }),
    });
    setBusy(false);
    if (!res.ok) {
      setMelding((await res.json()).error ?? 'Toevoegen mislukt');
      return;
    }
    setQuery('');
    router.refresh();
  }

  async function remove(id: string) {
    setBusy(true);
    await fetch(`/api/search-queries?id=${id}`, { method: 'DELETE' });
    setBusy(false);
    router.refresh();
  }

  return (
    <section className="space-y-3 rounded border border-neutral-800 p-4">
      <div>
        <h2 className="text-lg font-medium">Zoektermen op de platforms</h2>
        <p className="mt-1 text-sm text-neutral-500">
          De scout zoekt hier zelf mee op de platforms — ook posts van accounts die we niet volgen. Shorts werkt
          zonder scraping-key; TikTok en Reels vragen de ScrapeCreators-key.
        </p>
      </div>

      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="text-neutral-400">Zoekterm</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="bv. supergaande"
            className="mt-1 block w-56 rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="text-neutral-400">Platform</span>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="mt-1 block rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          >
            <option value="shorts">Shorts</option>
            <option value="tiktok">TikTok</option>
            <option value="reels">Reels</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="rounded border border-neutral-700 px-3 py-2 text-sm disabled:opacity-40"
        >
          Toevoegen
        </button>
      </form>

      {melding && <p className="text-sm text-red-400">{melding}</p>}

      <ul className="space-y-1">
        {queries.map((q) => (
          <li key={q.id} className="flex items-center justify-between rounded border border-neutral-800 px-3 py-2 text-sm">
            <span>
              &ldquo;{q.query}&rdquo; <span className="text-neutral-500">· {q.platform}</span>
            </span>
            <button onClick={() => remove(q.id)} disabled={busy} className="text-xs text-neutral-500 hover:text-red-400">
              verwijderen
            </button>
          </li>
        ))}
        {queries.length === 0 && <li className="text-sm text-neutral-500">Nog geen zoektermen.</li>}
      </ul>
    </section>
  );
}
