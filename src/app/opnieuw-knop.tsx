'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { roepApiAan } from './api-aanroep';

/** "Opnieuw proberen": POST naar de opgegeven route, melding eronder, pagina verversen. */
export function OpnieuwKnop({ url }: { url: string }) {
  const router = useRouter();
  const [bezig, setBezig] = useState(false);
  const [melding, setMelding] = useState<{ tekst: string; fout: boolean } | null>(null);

  async function klik() {
    setBezig(true);
    setMelding(null);
    const { ok, json, fout } = await roepApiAan<{ melding?: string }>(url, { method: 'POST' });
    setBezig(false);
    setMelding(
      ok ? { tekst: json.melding ?? 'Opnieuw gestart.', fout: false } : { tekst: fout ?? 'Mislukt', fout: true },
    );
    router.refresh();
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={klik}
        disabled={bezig}
        className="min-h-[40px] rounded border border-red-800 px-3 py-1.5 text-sm text-red-100 hover:bg-red-900/30 disabled:opacity-40"
      >
        {bezig ? 'Bezig…' : 'Opnieuw proberen'}
      </button>
      {melding && (
        <span className={`max-w-[16rem] text-right text-xs ${melding.fout ? 'text-red-400' : 'text-neutral-400'}`}>
          {melding.tekst}
        </span>
      )}
    </div>
  );
}
