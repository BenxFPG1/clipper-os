'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { roepApiAan } from '@/app/api-aanroep';

export type KennisItem = { id: string; categorie: string; titel: string; inhoud: string; bron: string | null };

/** Eén les met de knoppen om hem aan of uit te zetten. */
function Les({ les, knop }: { les: KennisItem; knop: 'beoordelen' | 'uitzetten' | 'aanzetten' }) {
  const router = useRouter();
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);

  async function besluit(b: 'aan' | 'uit') {
    setBezig(true);
    const { ok, fout: f } = await roepApiAan(`/api/kennis/${les.id}`, { method: 'PATCH', body: { besluit: b } });
    setBezig(false);
    if (!ok) setFout(f ?? 'Opslaan mislukt');
    else router.refresh();
  }

  return (
    <li className="rounded border border-neutral-800 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            <span className="mr-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400">{les.categorie}</span>
            {les.titel}
          </div>
          <p className="mt-1 whitespace-pre-line text-sm text-neutral-400">{les.inhoud}</p>
          {les.bron && <p className="mt-1 truncate text-xs text-neutral-600">bron: {les.bron.replace(/\[(wacht op akkoord|afgewezen)\]/g, '').trim()}</p>}
        </div>
        <div className="flex gap-2">
          {knop === 'beoordelen' && (
            <>
              <button onClick={() => besluit('aan')} disabled={bezig} className="rounded bg-emerald-800 px-3 py-1.5 text-sm text-emerald-50 disabled:opacity-40">
                Goedkeuren
              </button>
              <button onClick={() => besluit('uit')} disabled={bezig} className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 disabled:opacity-40">
                Afwijzen
              </button>
            </>
          )}
          {knop === 'uitzetten' && (
            <button onClick={() => besluit('uit')} disabled={bezig} className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 disabled:opacity-40">
              Uitzetten
            </button>
          )}
          {knop === 'aanzetten' && (
            <button onClick={() => besluit('aan')} disabled={bezig} className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 disabled:opacity-40">
              Aanzetten
            </button>
          )}
        </div>
      </div>
      {fout && <p className="mt-1 text-xs text-red-400">{fout}</p>}
    </li>
  );
}

export function KennisLijst({ items, knop }: { items: KennisItem[]; knop: 'beoordelen' | 'uitzetten' | 'aanzetten' }) {
  return (
    <ul className="space-y-2">
      {items.map((les) => (
        <Les key={les.id} les={les} knop={knop} />
      ))}
    </ul>
  );
}
