'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * De batch-acties van een campagne: concepten laten bedenken (geen briefing
 * typen) en verhaallijnen genereren voor alle opdrachten zonder script. De
 * aantallen zijn instelbaar; de begrenzing is tijd (elke verhaallijn is een
 * volledig script met examen, ±2-4 minuten), niet geld.
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
  const [aantalConcepten, setAantalConcepten] = useState(8);
  const [perOpdracht, setPerOpdracht] = useState(3);

  async function concepten() {
    setBusy('concepten');
    setMelding(null);
    const res = await fetch(`/api/campaigns/${campaignId}/concepten`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aantal: aantalConcepten }),
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

  async function alleScripts() {
    setMelding(null);
    let klaar = 0;
    for (const brief of briefsZonderScript) {
      setBusy(`opdracht ${klaar + 1}/${briefsZonderScript.length}: ${brief.titel.slice(0, 40)}`);
      const res = await fetch(`/api/briefs/${brief.id}/script`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aantal: perOpdracht }),
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
    setMelding(`Verhaallijnen gegenereerd voor ${klaar} opdracht(en).`);
    router.refresh();
  }

  const totaal = briefsZonderScript.length * perOpdracht;

  return (
    <div className="space-y-3 rounded border border-neutral-800 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={concepten}
          disabled={busy !== null}
          className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
        >
          {busy === 'concepten' ? 'Concepten bedenken…' : 'Concepten laten bedenken'}
        </button>
        <label className="flex items-center gap-2 text-sm text-neutral-400">
          aantal
          <input
            type="number"
            min={3}
            max={15}
            value={aantalConcepten}
            onChange={(e) => setAantalConcepten(Number(e.target.value))}
            className="w-16 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
          />
        </label>
      </div>

      {briefsZonderScript.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={alleScripts}
            disabled={busy !== null}
            className="rounded border border-neutral-700 px-4 py-2 text-sm disabled:opacity-40"
          >
            Verhaallijnen voor alle {briefsZonderScript.length} opdrachten zonder script
          </button>
          <label className="flex items-center gap-2 text-sm text-neutral-400">
            per opdracht
            <input
              type="number"
              min={1}
              max={11}
              value={perOpdracht}
              onChange={(e) => setPerOpdracht(Number(e.target.value))}
              className="w-16 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            />
          </label>
          <span className="text-xs text-neutral-500">
            = {totaal} verhaallijnen, elk in een andere stijl per opdracht (reken op ±2-4 min per stuk)
          </span>
        </div>
      )}

      {busy && busy !== 'concepten' && <span className="text-sm text-neutral-400">Bezig: {busy}</span>}
      {melding && <p className="text-sm text-neutral-400">{melding}</p>}
    </div>
  );
}
