'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Archiveren/terugzetten. Niets wordt verwijderd: de video verhuist naar het
 * archief onderaan de lijst en kan altijd terug.
 */
export function ArchiveButton({
  videoId,
  gearchiveerd,
  naArchiveren,
}: {
  videoId: string;
  gearchiveerd: boolean;
  /** Optioneel pad om naartoe te gaan na archiveren (bijv. terug naar de lijst). */
  naArchiveren?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const res = await fetch(`/api/videos/${videoId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gearchiveerd: !gearchiveerd }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      alert(json.error ?? 'Archiveren mislukt');
      return;
    }
    if (!gearchiveerd && naArchiveren) router.push(naArchiveren);
    router.refresh();
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
      title={gearchiveerd ? 'Terugzetten naar de werklijst' : 'Naar het archief (niets wordt verwijderd)'}
    >
      {busy ? 'Bezig…' : gearchiveerd ? 'Terugzetten' : 'Archiveren'}
    </button>
  );
}
