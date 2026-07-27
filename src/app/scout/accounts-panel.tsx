'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Account = {
  id: string;
  handle: string;
  platform: string;
  our_own: boolean;
  median_views_7d: number | null;
};

export function AccountsPanel({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [platform, setPlatform] = useState('tiktok');
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMelding(null);
    const res = await fetch('/api/tracked-accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, platform, our_own: false }),
    });
    setBusy(false);
    if (!res.ok) {
      setMelding((await res.json()).error ?? 'Toevoegen mislukt');
      return;
    }
    setHandle('');
    router.refresh();
  }

  async function remove(id: string) {
    setBusy(true);
    await fetch(`/api/tracked-accounts?id=${id}`, { method: 'DELETE' });
    setBusy(false);
    router.refresh();
  }

  async function runScout() {
    setBusy(true);
    setMelding('Scout draait…');
    const res = await fetch('/api/cron/scout');
    const json = await res.json();
    setBusy(false);
    setMelding(
      res.ok
        ? `Klaar: ${json.accountsBekeken} accounts, ${json.outliers} uitschieters, ${json.kandidaten} nieuwe kandidaat-regels.`
        : (json.error ?? 'Scout mislukt'),
    );
    router.refresh();
  }

  return (
    <section className="space-y-3 rounded border border-neutral-800 p-4">
      <h2 className="text-lg font-medium">Accounts die we volgen</h2>

      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="text-neutral-400">Handle</span>
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@concurrent"
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
            <option value="tiktok">TikTok</option>
            <option value="reels">Reels</option>
            <option value="shorts">Shorts</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || !handle.trim()}
          className="rounded border border-neutral-700 px-3 py-2 text-sm disabled:opacity-40"
        >
          Toevoegen
        </button>
        <button
          type="button"
          onClick={runScout}
          disabled={busy}
          className="rounded bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
        >
          Scout nu draaien
        </button>
      </form>

      {melding && <p className="text-sm text-neutral-400">{melding}</p>}

      <ul className="space-y-1">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-center justify-between rounded border border-neutral-800 px-3 py-2 text-sm">
            <span>
              @{a.handle} <span className="text-neutral-500">· {a.platform}</span>
              {a.our_own && <span className="ml-2 text-xs text-emerald-300">ons account</span>}
              {a.median_views_7d && (
                <span className="ml-2 text-xs text-neutral-600">
                  mediaan {a.median_views_7d.toLocaleString('nl-NL')}
                </span>
              )}
            </span>
            {!a.our_own && (
              <button onClick={() => remove(a.id)} disabled={busy} className="text-xs text-neutral-500 hover:text-red-400">
                verwijderen
              </button>
            )}
          </li>
        ))}
        {accounts.length === 0 && <li className="text-sm text-neutral-500">Nog geen accounts.</li>}
      </ul>
    </section>
  );
}
