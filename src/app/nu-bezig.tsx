'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { LopendeTaak } from '@/lib/status';

/**
 * Wat er nu draait, met voortgang. De schatting komt uit de gemeten duur van
 * eerdere opdrachten van dezelfde soort — geen verzonnen percentage. Duurt het
 * langer dan verwacht, dan zeggen we dat in plaats van op 99% te blijven staan.
 *
 * De lijst ververst zichzelf elke 20 seconden zodat je de balk ziet lopen.
 */
export function NuBezig({ taken }: { taken: LopendeTaak[] }) {
  const router = useRouter();
  const [tik, setTik] = useState(0);

  useEffect(() => {
    if (taken.length === 0) return;
    const timer = setInterval(() => {
      setTik((t) => t + 1);
      router.refresh();
    }, 20_000);
    return () => clearInterval(timer);
  }, [taken.length, router]);

  if (taken.length === 0) {
    return (
      <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
        Niets in de wachtrij. Alles wat draaide is klaar.
      </p>
    );
  }

  const bezig = taken.filter((t) => t.status === 'bezig');
  const wachtend = taken.filter((t) => t.status !== 'bezig');

  // Verwachte wachttijd voor de rij: alles wat ervoor staat bij elkaar opgeteld.
  const gemiddelde =
    wachtend.map((t) => t.schattingSeconden).filter((s): s is number => Boolean(s))[0] ?? null;

  return (
    <div key={tik} className="space-y-2">
      {bezig.map((t, i) => (
        <Regel key={`b${i}`} taak={t} />
      ))}
      {wachtend.map((t, i) => (
        <Regel key={`w${i}`} taak={t} wachttijd={gemiddelde ? gemiddelde * (t.wachtrijPlek ?? i + 1) : null} />
      ))}
    </div>
  );
}

function Regel({ taak, wachttijd }: { taak: LopendeTaak; wachttijd?: number | null }) {
  const bezig = taak.status === 'bezig';
  const schatting = taak.schattingSeconden;
  const verstreken = taak.bezigSeconden ?? 0;

  // Percentage alleen als we een gemeten schatting hebben. We tonen nooit meer
  // dan 95%: klaar is pas klaar als de opdracht dat zelf zegt.
  const pct = bezig && schatting ? Math.min(95, Math.round((verstreken / schatting) * 100)) : null;
  const resterend = bezig && schatting ? Math.max(0, schatting - verstreken) : null;

  return (
    <div className="rounded border border-neutral-800 px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="font-medium">{taak.soort}</span>
          <span className="ml-2 text-sm text-neutral-400">{taak.wat}</span>
        </span>
        <span className="shrink-0 text-sm">
          {bezig ? (
            <span className="rounded bg-emerald-900/50 px-2 py-0.5 text-xs text-emerald-200">
              {pct !== null ? `${pct}%` : 'bezig'}
            </span>
          ) : (
            <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
              {taak.wachtrijPlek ? `#${taak.wachtrijPlek} in de rij` : 'wachtend'}
            </span>
          )}
        </span>
      </div>

      {bezig && (
        <>
          <div className="mt-2 h-1 overflow-hidden rounded bg-neutral-800">
            <div
              className="h-full bg-emerald-600 transition-all duration-1000"
              style={{ width: `${pct ?? 30}%` }}
            />
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            {duur(verstreken)} bezig
            {resterend !== null
              ? resterend > 0
                ? ` · nog ongeveer ${duur(resterend)}`
                : ' · duurt langer dan gewoonlijk'
              : ' · duur nog niet in te schatten (eerste keer)'}
          </div>
        </>
      )}

      {!bezig && wachttijd ? (
        <div className="mt-1 text-xs text-neutral-500">start over ongeveer {duur(wachttijd)}</div>
      ) : null}
    </div>
  );
}

function duur(seconden: number): string {
  if (seconden < 60) return `${seconden}s`;
  const m = Math.round(seconden / 60);
  if (m < 60) return `${m} min`;
  const u = Math.floor(m / 60);
  return `${u} uur ${m % 60} min`;
}
