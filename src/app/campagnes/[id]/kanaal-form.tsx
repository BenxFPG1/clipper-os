'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { datumTijd } from '@/lib/format';

/** Ouder dan dit is vastgelopen, niet "nog bezig" — zie ook lib/status.ts. */
const KANAAL_STALE_MS = 20 * 60 * 1000;

/**
 * Bronkanalen van de campagne. Meerdere bronnen kunnen: een hoofdkanaal, een
 * shorts-kanaal, een tweede programma of een losse playlist. De dagelijkse
 * cloudrun loopt ze allemaal langs, haalt nieuwe uploads op met transcript en
 * zet er meteen een clip-plan op.
 */
export function KanaalForm({
  campaignId,
  kanalen,
  autoPlan,
  laatsteCheck,
  laatsteFouten,
  checkGestartAt,
}: {
  campaignId: string;
  kanalen: string[];
  autoPlan: boolean;
  laatsteCheck: string | null;
  laatsteFouten: string[];
  checkGestartAt: string | null;
}) {
  const router = useRouter();
  const [lijst, setLijst] = useState<string[]>(kanalen.length ? kanalen : ['']);
  const [plan, setPlan] = useState(autoPlan);
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);
  const [fouten, setFouten] = useState<string[]>([]);

  const loopt = Boolean(checkGestartAt) && Date.now() - new Date(checkGestartAt!).getTime() < KANAAL_STALE_MS;

  // Zolang de check loopt elke 15s verversen, zodat "bezig" vanzelf verdwijnt
  // zodra de worker klaar is (of stilstaat na de staleness-grens hierboven) —
  // zonder dit zag je na een klik niets meer gebeuren tot je zelf herlaadde.
  useEffect(() => {
    if (!loopt) return;
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [loopt, router]);

  function wijzig(i: number, waarde: string) {
    setLijst((l) => l.map((k, n) => (n === i ? waarde : k)));
  }

  async function opslaan(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMelding(null);
    const schoon = lijst.map((k) => k.trim()).filter(Boolean);
    const res = await fetch(`/api/campaigns/${campaignId}/kanaal`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bron_kanalen: schoon, auto_plan: plan }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMelding(json.error ?? 'Opslaan mislukt');
      return;
    }
    setLijst(schoon.length ? schoon : ['']);
    setMelding(
      schoon.length
        ? `${schoon.length} bron(nen) opgeslagen. De dagelijkse run haalt nieuwe uploads voortaan zelf op.`
        : 'Bronnen leeggemaakt.',
    );
    router.refresh();
  }

  async function nuOphalen() {
    setBusy(true);
    setMelding(null);
    const res = await fetch(`/api/campaigns/${campaignId}/kanaal`, { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    setMelding(res.ok ? (json.melding ?? 'Ophalen gestart.') : (json.error ?? 'Ophalen mislukt'));
    // De problemen uit dit antwoord direct tonen: eerder stond er alleen
    // "4 probleem(en) — zie hieronder" zonder dat er iets onder stond.
    setFouten(Array.isArray(json.fouten) ? json.fouten : []);
    router.refresh();
  }

  return (
    <form onSubmit={opslaan} className="space-y-3 rounded border border-neutral-800 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500">Bronnen (automatisch ophalen)</h2>
        {laatsteCheck && <span className="text-xs text-neutral-500">laatst gecheckt {datumTijd(laatsteCheck)}</span>}
      </div>

      {loopt && (
        <div className="flex items-center gap-2 rounded border border-emerald-900/60 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-200">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
          Nieuwe uploads zoeken — bezig sinds {duurSinds(checkGestartAt!)}
        </div>
      )}

      <div className="space-y-2">
        {lijst.map((kanaal, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={kanaal}
              onChange={(e) => wijzig(i, e.target.value)}
              placeholder="https://www.youtube.com/@kanaalnaam (of een playlist-URL)"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
            />
            {lijst.length > 1 && (
              <button
                type="button"
                onClick={() => setLijst((l) => l.filter((_, n) => n !== i))}
                className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
                title="Bron verwijderen"
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setLijst((l) => [...l, ''])}
          className="text-sm text-neutral-400 hover:text-neutral-200"
        >
          + nog een bron
        </button>
      </div>

      {(fouten.length > 0 || laatsteFouten.length > 0) && (
        <div className="rounded border border-amber-900/60 bg-amber-950/20 p-3">
          <div className="text-xs uppercase tracking-wide text-amber-400/80">
            Bij de laatste check ging dit mis
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            Video&apos;s zonder ondertiteling worden zelf getranscribeerd; dat duurt ongeveer een halve minuut
            per minuut video. Zolang dat loopt staat de video er nog niet.
          </p>
          <ul className="mt-1 space-y-0.5 text-sm text-neutral-300">
            {(fouten.length > 0 ? fouten : laatsteFouten).map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-neutral-400">
        <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} />
        Meteen een clip-plan maken voor elke nieuwe video
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {busy ? 'Bezig…' : 'Opslaan'}
        </button>
        {kanalen.length > 0 && (
          <button
            type="button"
            onClick={nuOphalen}
            disabled={busy}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Nu nieuwe uploads ophalen
          </button>
        )}
        {melding && <span className="text-sm text-neutral-400">{melding}</span>}
      </div>
    </form>
  );
}

function duurSinds(iso: string): string {
  const seconden = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconden < 60) return `${seconden}s`;
  const m = Math.round(seconden / 60);
  return `${m} min`;
}
