'use client';

import { useState } from 'react';
import { roepApiAan } from './api-aanroep';

/**
 * Optionele smaak-eval: zet voor elke render in de eval-set een nieuwe render
 * klaar met de huidige code. Blokkeert niets; de vergelijking draai je daarna
 * zelf met `npm run eval:smaak -- --uitslag`.
 */
export function EvalKnop({ aantal }: { aantal: number }) {
  const [bezig, setBezig] = useState(false);
  const [melding, setMelding] = useState<{ tekst: string; fout: boolean } | null>(null);

  async function start() {
    setBezig(true);
    setMelding(null);
    const { ok, json, fout } = await roepApiAan<{ melding?: string }>('/api/renders/eval', { method: 'POST' });
    setBezig(false);
    setMelding(ok ? { tekst: json.melding ?? 'Klaargezet.', fout: false } : { tekst: fout ?? 'Mislukt', fout: true });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-neutral-800 pt-3">
      <button
        type="button"
        onClick={start}
        disabled={bezig}
        className="min-h-[44px] rounded border border-neutral-600 px-4 py-2 text-sm disabled:opacity-40"
      >
        {bezig ? 'Bezig…' : 'Eval draaien'}
      </button>
      <span className="text-xs text-neutral-500">
        {aantal} render{aantal === 1 ? '' : 's'} in de eval-set · optioneel, rendert ze opnieuw met de huidige code
      </span>
      {melding && <p className={`w-full text-xs ${melding.fout ? 'text-red-400' : 'text-neutral-400'}`}>{melding.tekst}</p>}
    </div>
  );
}
