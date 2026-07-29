'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Theme = {
  slug: string;
  name: string;
  description: string | null;
  zoektermen: string[];
  actief: boolean;
};

/**
 * Thema's bepalen twee dingen tegelijk: waar de scout op zoekt, en onder welke
 * noemer de opgedane kennis wordt opgeslagen. Alle accounts delen dezelfde
 * vault, maar comedy krijgt andere gewichten dan financiën.
 */
export function ThemesPanel({ themes }: { themes: Theme[] }) {
  const router = useRouter();
  const [naam, setNaam] = useState('');
  const [zoektermen, setZoektermen] = useState('');
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMelding(null);

    const res = await fetch('/api/themes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: naam,
        name: naam,
        zoektermen: zoektermen.split(',').map((z) => z.trim()).filter(Boolean),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setMelding((await res.json()).error ?? 'Toevoegen mislukt');
      return;
    }
    setNaam('');
    setZoektermen('');
    router.refresh();
  }

  async function remove(slug: string) {
    setBusy(true);
    await fetch(`/api/themes?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
    setBusy(false);
    router.refresh();
  }

  return (
    <section className="space-y-3 rounded border border-neutral-800 p-4">
      <div>
        <h2 className="text-lg font-medium">Thema&apos;s</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Per thema wordt apart geleerd: wat werkt in comedy is iets anders dan wat werkt in financiën. De scout zoekt
          met deze termen op alle platforms, en de vault houdt de gewichten per thema uit elkaar.
        </p>
      </div>

      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="text-neutral-400">Thema</span>
          <input
            value={naam}
            onChange={(e) => setNaam(e.target.value)}
            placeholder="bv. financien"
            className="mt-1 block w-44 rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          />
        </label>
        <label className="flex-1 text-sm">
          <span className="text-neutral-400">Zoektermen (komma-gescheiden)</span>
          <input
            value={zoektermen}
            onChange={(e) => setZoektermen(e.target.value)}
            placeholder="geld besparen, beleggen beginners"
            className="mt-1 block w-full min-w-64 rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !naam.trim()}
          className="rounded border border-neutral-700 px-3 py-2 text-sm disabled:opacity-40"
        >
          Toevoegen
        </button>
      </form>

      {melding && <p className="text-sm text-red-400">{melding}</p>}

      <ul className="space-y-1">
        {themes.map((t) => (
          <li key={t.slug} className="flex items-start justify-between rounded border border-neutral-800 px-3 py-2 text-sm">
            <span>
              <span className="font-medium">{t.name}</span>{' '}
              <span className="font-mono text-xs text-neutral-500">{t.slug}</span>
              {t.zoektermen.length > 0 && (
                <span className="block text-xs text-neutral-500">zoekt op: {t.zoektermen.join(' · ')}</span>
              )}
            </span>
            <button onClick={() => remove(t.slug)} disabled={busy} className="text-xs text-neutral-500 hover:text-red-400">
              verwijderen
            </button>
          </li>
        ))}
        {themes.length === 0 && <li className="text-sm text-neutral-500">Nog geen thema&apos;s.</li>}
      </ul>
    </section>
  );
}
