'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * B-roll-campagnes: een Drive-map met losse shots in plaats van één lange
 * bronvideo. De cloud haalt de beelden op, bekijkt en categoriseert ze
 * (kijk-agent), doet stijlonderzoek voor het genre en bouwt er een editplan
 * van — een edit in plaats van een verhaal-uit-spraak.
 */
export function BrollForm({ campaignId, driveUrl, aantalShots }: { campaignId: string; driveUrl: string | null; aantalShots: number }) {
  const router = useRouter();
  const [url, setUrl] = useState(driveUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setMelding(null);
    const res = await fetch(`/api/campaigns/${campaignId}/broll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ drive_url: url }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    setMelding(res.ok ? (json.melding ?? 'Gestart.') : (json.error ?? 'Starten mislukt'));
    router.refresh();
  }

  return (
    <div className="space-y-3 rounded border border-neutral-800 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500">B-roll (Drive-map → edit)</h2>
        {aantalShots > 0 && <span className="text-xs text-neutral-500">{aantalShots} shots binnengehaald</span>}
      </div>
      <p className="text-sm text-neutral-500">
        Plak de gedeelde Google Drive-map (instelling: &ldquo;iedereen met de link&rdquo;). De cloud haalt de
        beelden op, bekijkt en categoriseert elk shot, onderzoekt wat er in dit genre werkt, en bouwt er een
        editplan van dat je hieronder bij de bronvideo&apos;s kunt renderen.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://drive.google.com/drive/folders/…"
          className="w-full max-w-xl rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <button
          onClick={start}
          disabled={busy || !url.trim()}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {busy ? 'Bezig…' : aantalShots > 0 ? 'Opnieuw ophalen + nieuw editplan' : 'Beelden ophalen + editplan maken'}
        </button>
      </div>
      {melding && <p className="text-sm text-neutral-400">{melding}</p>}
    </div>
  );
}
