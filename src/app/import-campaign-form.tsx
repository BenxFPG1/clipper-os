'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Campagne-import: plak de tekst van een campagnepagina (ClipArmy, Whop) en
 * de tool parst er regels, CPM en verboden content uit. Bewust plakken in
 * plaats van scrapen: dat mag van de spec niet, en zo controleer je meteen
 * wat er binnenkomt.
 */
export function ImportCampaignForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tekst, setTekst] = useState('');
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMelding(null);

    const res = await fetch('/api/campaigns/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tekst }),
    });
    const json = await res.json();
    setBusy(false);

    if (!res.ok) {
      setMelding(json.error ?? 'Import mislukt');
      return;
    }

    setTekst('');
    setOpen(false);
    setMelding(
      json.onduidelijk?.length
        ? `Campagne "${json.campaign.name}" aangemaakt${json.bronKanaal ? ` met bronkanaal ${json.bronKanaal}` : ''}. Nog controleren: ${json.onduidelijk.join('; ')}`
        : `Campagne "${json.campaign.name}" aangemaakt${json.bronKanaal ? ` met bronkanaal ${json.bronKanaal}` : ''}.`,
    );
    // Direct door naar de werkplek van de nieuwe campagne.
    router.push(`/campagnes/${json.campaign.id}`);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      {!open && (
        <button onClick={() => setOpen(true)} className="rounded border border-neutral-700 px-3 py-2 text-sm">
          Campagne importeren (plak tekst)
        </button>
      )}

      {open && (
        <form onSubmit={submit} className="space-y-2 rounded border border-neutral-800 p-4">
          <p className="text-sm text-neutral-400">
            Open de campagne op ClipArmy of Whop, selecteer alles (Cmd+A, Cmd+C) en plak hieronder. De regels, CPM en
            verboden content worden er automatisch uit gehaald.
          </p>
          <textarea
            value={tekst}
            onChange={(e) => setTekst(e.target.value)}
            rows={8}
            placeholder="Plak hier de volledige campagnetekst…"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || tekst.trim().length < 40}
              className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
            >
              {busy ? 'Bezig…' : 'Importeren'}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded border border-neutral-700 px-3 py-2 text-sm">
              Annuleren
            </button>
          </div>
        </form>
      )}

      {melding && <p className="text-sm text-neutral-400">{melding}</p>}
    </div>
  );
}
