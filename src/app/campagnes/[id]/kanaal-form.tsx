'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { roepApiAan } from '@/app/api-aanroep';
import { datumTijd } from '@/lib/format';
import { beschrijfBron, herkenBron, hoortBijBron } from '@/lib/ingest/bron-url';

/** Ouder dan dit is vastgelopen, niet "nog bezig" — zie ook lib/status.ts. */
const KANAAL_STALE_MS = 20 * 60 * 1000;

/**
 * Bronnen van de campagne. Meerdere kunnen: een YouTube-kanaal of -video, een
 * playlist, een Google Drive-map of -bestand, een WeTransfer. De dagelijkse
 * cloudrun loopt ze allemaal langs, haalt nieuwe video's op met transcript en
 * zet er meteen een clip-plan op. Elke link wordt bij het typen al herkend
 * (of afgewezen, met de reden), en per bron staat erbij hoe het ervoor staat.
 */
export function KanaalForm({
  campaignId,
  kanalen,
  autoPlan,
  laatsteCheck,
  laatsteFouten,
  checkGestartAt,
  videoBronnen = [],
  bezigeBronnen = [],
}: {
  campaignId: string;
  kanalen: string[];
  autoPlan: boolean;
  laatsteCheck: string | null;
  laatsteFouten: string[];
  checkGestartAt: string | null;
  /** source_url van de video's van deze campagne: daaruit volgt "N opgehaald" per bron. */
  videoBronnen?: string[];
  /** Bronnen waarvoor nu een ophaalopdracht in de cloud wacht of loopt. */
  bezigeBronnen?: string[];
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
    const schoon = lijst.map((k) => k.trim()).filter(Boolean);
    const ongeldig = schoon.map((k) => herkenBron(k)).find((b) => b.soort === 'onbekend');
    if (ongeldig && ongeldig.soort === 'onbekend') {
      setMelding(`Niet opgeslagen: ${ongeldig.reden}`);
      return;
    }
    setBusy(true);
    setMelding(null);
    const { ok, fout } = await roepApiAan(`/api/campaigns/${campaignId}/kanaal`, {
      method: 'PATCH',
      body: { bron_kanalen: schoon, auto_plan: plan },
    });
    setBusy(false);
    if (!ok) {
      setMelding(fout ?? 'Opslaan mislukt');
      return;
    }
    setLijst(schoon.length ? schoon : ['']);
    // Een nieuwe bron meteen ophalen: niemand wil tot morgen 06:00 wachten
    // om te zien of de Drive-map wel openbaar is.
    const nieuw = schoon.filter((k) => !kanalen.includes(k));
    if (nieuw.length > 0) {
      await nuOphalen();
      return;
    }
    setMelding(
      schoon.length
        ? `${schoon.length} bron(nen) opgeslagen. De dagelijkse run haalt nieuwe video's voortaan zelf op.`
        : 'Bronnen leeggemaakt.',
    );
    router.refresh();
  }

  /** Hoe staat deze bron ervoor? Herkenning tijdens het typen, daarna de uitkomst van de laatste check. */
  function statusVan(invoer: string): { tekst: string; klasse: string } | null {
    const k = invoer.trim();
    if (!k) return null;
    const bron = herkenBron(k);
    if (bron.soort === 'onbekend') return { tekst: bron.reden, klasse: 'text-red-400' };
    const soort = beschrijfBron(bron);
    if (!kanalen.includes(k))
      return { tekst: `${soort} herkend — wordt na opslaan meteen opgehaald`, klasse: 'text-neutral-400' };
    if (loopt || bezigeBronnen.includes(k))
      return { tekst: `${soort} · bezig met ophalen…`, klasse: 'text-emerald-300' };
    const fout = laatsteFouten.find((f) => f.includes(k));
    const aantal = videoBronnen.filter((u) => hoortBijBron(k, u)).length;
    if (fout) {
      const reden = fout.slice(fout.indexOf(k) + k.length).replace(/^:\s*/, '');
      return { tekst: `${soort} · ${aantal > 0 ? `${aantal} opgehaald, ` : ''}fout: ${reden}`, klasse: 'text-red-400' };
    }
    if (aantal > 0)
      return { tekst: `${soort} · ${aantal} video${aantal === 1 ? '' : "'s"} opgehaald`, klasse: 'text-emerald-400' };
    if (bron.soort === 'youtube_kanaal' || bron.soort === 'youtube_playlist') {
      return {
        tekst: laatsteCheck ? `${soort} · gecheckt, geen fouten` : `${soort} · nog niet gecheckt`,
        klasse: 'text-neutral-400',
      };
    }
    return {
      tekst: laatsteCheck ? `${soort} · nog niets opgehaald` : `${soort} · nog niet opgehaald`,
      klasse: 'text-neutral-400',
    };
  }

  async function nuOphalen() {
    setBusy(true);
    setMelding(null);
    const { ok, json, fout } = await roepApiAan<{ melding?: string; fouten?: string[] }>(
      `/api/campaigns/${campaignId}/kanaal`,
      { method: 'POST' },
    );
    setBusy(false);
    setMelding(ok ? (json.melding ?? 'Ophalen gestart.') : (fout ?? 'Ophalen mislukt'));
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
        {lijst.map((kanaal, i) => {
          const status = statusVan(kanaal);
          return (
            <div key={i} className="space-y-0.5">
              <div className="flex items-center gap-2">
                <input
                  value={kanaal}
                  onChange={(e) => wijzig(i, e.target.value)}
                  placeholder="YouTube-kanaal of -video, Google Drive-map of -bestand, WeTransfer-link"
                  className={`w-full rounded border bg-neutral-900 px-3 py-2 text-sm ${
                    status?.klasse === 'text-red-400' && !kanalen.includes(kanaal.trim())
                      ? 'border-red-800'
                      : 'border-neutral-700'
                  }`}
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
              {status && <p className={`pl-1 text-xs ${status.klasse}`}>{status.tekst}</p>}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => setLijst((l) => [...l, ''])}
          className="text-sm text-neutral-400 hover:text-neutral-200"
        >
          + bron toevoegen
        </button>
      </div>

      {(fouten.length > 0 || laatsteFouten.length > 0) && (
        <div className="rounded border border-amber-900/60 bg-amber-950/20 p-3">
          <div className="text-xs uppercase tracking-wide text-amber-400/80">Bij de laatste check ging dit mis</div>
          <p className="mt-1 text-xs text-neutral-500">
            Video&apos;s zonder ondertiteling (en alles uit Drive of WeTransfer) worden zelf getranscribeerd; dat duurt
            ongeveer een halve minuut per minuut video. Zolang dat loopt staat de video er nog niet.
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
            Nu nieuwe video&apos;s ophalen
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
