import Link from 'next/link';
import type { VastgelopenItem } from '@/lib/status';
import { datumTijd } from '@/lib/format';
import { OpnieuwKnop } from './opnieuw-knop';

/**
 * Rood blok bovenaan het dashboard: wat vastzit en niet vanzelf goedkomt.
 * Leeg = niets te zien. Per regel de reden in gewone taal en een knop om het
 * opnieuw te proberen (een opdracht terug in de wachtrij, of de bron van een
 * campagne opnieuw ophalen).
 */
export function VastgelopenBlok({ items }: { items: VastgelopenItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-3 rounded border border-red-900/70 bg-red-950/20 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium text-red-200">Vastgelopen ({items.length})</h2>
        <span className="text-xs text-red-300/70">Komt niet vanzelf goed — kijk ernaar of probeer het opnieuw.</span>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={`${item.soort}:${item.id}`} className="rounded border border-red-900/40 bg-neutral-950/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-neutral-100">
                  {item.href ? (
                    <Link href={item.href} className="hover:underline">
                      {item.wat}
                    </Link>
                  ) : (
                    item.wat
                  )}
                </div>
                <p className="mt-0.5 text-sm text-red-200/90">{item.reden}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {item.sinds ? datumTijd(item.sinds) : ''}
                  {item.herkansingOm ? ` · automatische herkansing na ${datumTijd(item.herkansingOm)}` : ''}
                </p>
                {item.detail && item.detail !== item.reden && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-neutral-500">details</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-neutral-400">{item.detail}</pre>
                  </details>
                )}
              </div>
              <OpnieuwKnop
                url={item.soort === 'opdracht' ? `/api/ai-jobs/${item.id}/opnieuw` : `/api/campaigns/${item.id}/kanaal`}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
