'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Campagne archiveren in plaats van verwijderen: alles blijft bewaard voor de
 * vault en de retro, maar de campagne verdwijnt uit de werklijst, uit het
 * dashboard en uit de dagelijkse kanaalcheck.
 */
export function ArchiveerCampagne({ campaignId, status }: { campaignId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const gearchiveerd = status === 'ended';

  async function toggle() {
    setBusy(true);
    const res = await fetch(`/api/campaigns/${campaignId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: gearchiveerd ? 'active' : 'ended' }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      alert(json.error ?? 'Archiveren mislukt');
      return;
    }
    router.refresh();
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
      title={
        gearchiveerd
          ? 'Terugzetten naar de werklijst'
          : 'Naar het archief: alles blijft bewaard, maar de campagne verdwijnt uit de werklijst en de kanaalcheck'
      }
    >
      {busy ? 'Bezig…' : gearchiveerd ? 'Campagne terugzetten' : 'Campagne archiveren'}
    </button>
  );
}
