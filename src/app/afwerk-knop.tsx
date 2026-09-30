'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { roepApiAan } from '@/app/api-aanroep';

type Status = {
  status: 'wachtend' | 'bezig' | 'klaar' | 'mislukt' | null;
  voortgang?: string | null;
  fout?: string | null;
  meldingen?: string[];
  bytes?: number | null;
  url?: string | null;
  melding?: string;
};

/**
 * "Afwerken in Premiere" voor één gerenderd bestand: vraagt het pakket aan
 * (Premiere-project met de 4K-bron, kaarten, audio en ondertitels) en toont
 * daarna de downloadlink. Het bouwen gebeurt in de cloud; zolang dat loopt
 * vraagt de knop elke 15 s de status op.
 */
export function AfwerkKnop({ jobId, bestandNaam, compact = false }: { jobId: string; bestandNaam: string; compact?: boolean }) {
  const [s, setS] = useState<Status | null>(null);
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const vraagStatus = useCallback(async () => {
    const { ok, json } = await roepApiAan<Status>(
      `/api/renders/${jobId}/afwerkpakket?bestand=${encodeURIComponent(bestandNaam)}`,
    );
    if (ok) setS(json);
    return ok ? json : null;
  }, [jobId, bestandNaam]);

  // Eén keer bij het tonen: bestaat er al een pakket, dan meteen de link.
  useEffect(() => {
    void vraagStatus();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [vraagStatus]);

  // Zolang hij loopt: blijven kijken.
  useEffect(() => {
    if (s?.status !== 'wachtend' && s?.status !== 'bezig') return;
    timer.current = setTimeout(() => void vraagStatus(), 15_000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [s, vraagStatus]);

  async function vraagAan(opnieuw = false) {
    setBezig(true);
    setFout(null);
    const { ok, json, fout } = await roepApiAan<Status>(`/api/renders/${jobId}/afwerkpakket`, {
      method: 'POST',
      body: { bestand_naam: bestandNaam, opnieuw },
    });
    setBezig(false);
    if (!ok) setFout(fout ?? 'Aanvragen mislukt');
    else setS(json);
  }

  const klein = compact ? 'text-[11px]' : 'text-xs';

  if (s?.status === 'klaar' && s.url) {
    return (
      <div className={`mt-1 ${klein}`}>
        <a href={s.url} className="underline hover:text-neutral-100">
          Premiere-pakket downloaden{s.bytes ? ` (${Math.round(s.bytes / 1e6)} MB)` : ''}
        </a>
        <button type="button" onClick={() => vraagAan(true)} disabled={bezig} className="ml-2 text-neutral-500 underline">
          opnieuw maken
        </button>
        {s.meldingen && s.meldingen.length > 0 && (
          <ul className="ml-4 mt-0.5 list-disc text-amber-300/80">
            {s.meldingen.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (s?.status === 'wachtend' || s?.status === 'bezig') {
    return (
      <p className={`mt-1 ${klein} text-neutral-400`}>
        Pakket wordt gemaakt…{s.voortgang ? <span className="ml-1 text-neutral-500">({s.voortgang})</span> : null}
      </p>
    );
  }

  return (
    <div className={`mt-1 ${klein}`}>
      <button
        type="button"
        onClick={() => vraagAan(s?.status === 'mislukt')}
        disabled={bezig}
        className="rounded border border-neutral-700 px-2 py-1 hover:border-neutral-500 disabled:opacity-40"
      >
        {bezig ? 'Bezig…' : 'Afwerken in Premiere'}
      </button>
      {s?.status === 'mislukt' && s.fout && <span className="ml-2 text-red-400">{s.fout}</span>}
      {fout && <span className="ml-2 text-red-400">{fout}</span>}
    </div>
  );
}
