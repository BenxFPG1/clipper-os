'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { roepApiAan } from '@/app/api-aanroep';

/**
 * Twee stappen in plaats van een browser-dialoog: eerst vragen, dan pas doen.
 * Wijst alle openstaande retro-voorstellen af behalve de nieuwste.
 */
export function VerouderdKnop({ aantal }: { aantal: number }) {
  const router = useRouter();
  const [bevestigen, setBevestigen] = useState(false);
  const [bezig, setBezig] = useState(false);
  const [melding, setMelding] = useState<{ tekst: string; fout: boolean } | null>(null);

  async function doe() {
    setBezig(true);
    setMelding(null);
    const { ok, json, fout } = await roepApiAan<{ afgewezen?: number }>('/api/agents/runs/verouderd', { method: 'POST' });
    setBezig(false);
    setBevestigen(false);
    if (!ok) {
      setMelding({ tekst: fout ?? 'Afwijzen mislukt', fout: true });
      return;
    }
    setMelding({ tekst: `${json.afgewezen ?? 0} oudere voorstel(len) afgewezen.`, fout: false });
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {!bevestigen ? (
        <button
          type="button"
          onClick={() => setBevestigen(true)}
          className="min-h-[40px] rounded border border-neutral-700 px-3 py-2 text-neutral-300 hover:border-neutral-500"
        >
          {aantal} oudere voorstel{aantal === 1 ? '' : 'len'} afwijzen als verouderd
        </button>
      ) : (
        <>
          <span className="text-neutral-300">
            Alle {aantal} oudere retro-voorstellen afwijzen? De nieuwste blijft staan.
          </span>
          <button
            type="button"
            onClick={doe}
            disabled={bezig}
            className="min-h-[40px] rounded bg-red-500/90 px-3 py-2 font-medium text-neutral-950 disabled:opacity-40"
          >
            {bezig ? 'Bezig…' : 'Ja, afwijzen'}
          </button>
          <button
            type="button"
            onClick={() => setBevestigen(false)}
            disabled={bezig}
            className="min-h-[40px] rounded border border-neutral-700 px-3 py-2"
          >
            Annuleren
          </button>
        </>
      )}
      {melding && <span className={melding.fout ? 'text-red-400' : 'text-neutral-500'}>{melding.tekst}</span>}
    </div>
  );
}
