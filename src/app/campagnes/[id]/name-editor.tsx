'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Campagnenaam ter plekke aanpassen: klik op het potlood, typ, opslaan. */
export function NameEditor({ campaignId, naam }: { campaignId: string; naam: string }) {
  const router = useRouter();
  const [bewerken, setBewerken] = useState(false);
  const [waarde, setWaarde] = useState(naam);
  const [busy, setBusy] = useState(false);

  async function opslaan(e: React.FormEvent) {
    e.preventDefault();
    if (!waarde.trim() || waarde.trim() === naam) {
      setBewerken(false);
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/campaigns/${campaignId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: waarde.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      alert(json.error ?? 'Naam opslaan mislukt');
      return;
    }
    setBewerken(false);
    router.refresh();
  }

  if (!bewerken) {
    return (
      <span className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold">{naam}</h1>
        <button
          onClick={() => {
            setWaarde(naam);
            setBewerken(true);
          }}
          className="text-sm text-neutral-500 hover:text-neutral-200"
          title="Naam aanpassen"
        >
          ✎
        </button>
      </span>
    );
  }

  return (
    <form onSubmit={opslaan} className="flex items-center gap-2">
      <input
        value={waarde}
        onChange={(e) => setWaarde(e.target.value)}
        autoFocus
        className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xl font-semibold"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
      >
        {busy ? 'Bezig…' : 'Opslaan'}
      </button>
      <button type="button" onClick={() => setBewerken(false)} className="text-sm text-neutral-500">
        Annuleren
      </button>
    </form>
  );
}
