'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * De twee batch-acties van een campagne: concepten laten bedenken (geen
 * briefing typen) en scripts genereren voor alle opdrachten die er nog geen
 * hebben. De scripts lopen één voor één; de voortgang staat in de knop.
 */
export function BatchKnoppen({
  campaignId,
  briefsZonderScript,
}: {
  campaignId: string;
  briefsZonderScript: { id: string; titel: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);

  async function concepten() {
    setBusy('concepten');
    setMelding(null);
    const res = await fetch(`/api/campaigns/${campaignId}/concepten`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aantal: 6 }),
    });
    const json = await res.json();
    setBusy(null);
    if (!res.ok) {
      setMelding(json.error ?? 'Concepten bedenken mislukt');
      return;
    }
    setMelding(`${json.briefs.length} concepten toegevoegd.`);
    router.refresh();
  }

  async function alleScripts(aantalPerOpdracht: number) {
    setMelding(null);
    let klaar = 0;
    for (const brief of briefsZonderScript) {
      setBusy(`scripts ${klaar + 1}/${briefsZonderScript.length}: ${brief.titel.slice(0, 40)}`);
      const res = await fetch(`/api/briefs/${brief.id}/script`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aantal: aantalPerOpdracht }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setBusy(null);
        setMelding(`Gestopt bij "${brief.titel}": ${json.error ?? 'genereren mislukt'} (${klaar} gelukt)`);
        router.refresh();
        return;
      }
      klaar += 1;
      router.refresh();
    }
    setBusy(null);
    setMelding(`Scripts gegenereerd voor ${klaar} opdracht(en).`);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-neutral-800 p-4">
      <button
        onClick={concepten}
        disabled={busy !== null}
        className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
      >
        {busy === 'concepten' ? 'Concepten bedenken…' : 'Concepten laten bedenken (6)'}
      </button>
      {briefsZonderScript.length > 0 && (
        <>
          <button
            onClick={() => alleScripts(1)}
            disabled={busy !== null}
            className="rounded border border-neutral-700 px-4 py-2 text-sm disabled:opacity-40"
          >
            Script voor alle {briefsZonderScript.length} opdrachten zonder script
          </button>
          <button
            onClick={() => alleScripts(3)}
            disabled={busy !== null}
            className="rounded border border-neutral-700 px-4 py-2 text-sm disabled:opacity-40"
            title="Per opdracht drie verhaallijnen in verschillende stijlen — duurt het langst"
          >
            3 verhaallijnen per opdracht
          </button>
        </>
      )}
      {busy && busy !== 'concepten' && <span className="text-sm text-neutral-400">Bezig: {busy}</span>}
      {melding && <p className="w-full text-sm text-neutral-400">{melding}</p>}
    </div>
  );
}
