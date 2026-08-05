'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * ClipArmy automatisch laten ophalen zodat de cloud zelf nieuwe campagnes
 * binnenhaalt — ook als je laptop dicht is.
 *
 * Je plakt hier het verzoek dat je eigen browser doet ("Copy as cURL"), niet je
 * wachtwoord. Een wachtwoord geeft volledige toegang tot je account en zou in
 * onze database staan; dit token leest alleen wat jij zelf ook ziet, verloopt
 * vanzelf, en je trekt het in door op ClipArmy uit te loggen.
 */
export function ClipArmySessie({
  ingesteld,
  laatsteCheck,
  laatsteFout,
}: {
  ingesteld: boolean;
  laatsteCheck: string | null;
  laatsteFout: string | null;
}) {
  const router = useRouter();
  const [curl, setCurl] = useState('');
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  async function bewaar(waarde: string) {
    setBusy(true);
    setMelding(null);
    const res = await fetch('/api/platform-sessie', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'cliparmy', curl: waarde }),
    });
    const uit = (await res.json()) as { error?: string; verzoek?: string };
    setBusy(false);
    if (!res.ok) {
      setMelding(uit.error ?? 'Opslaan mislukt');
      return;
    }
    setMelding(waarde ? `Bewaard (${uit.verzoek}). De cloud checkt vanaf nu elk uur.` : 'Sessie gewist.');
    setCurl('');
    router.refresh();
  }

  return (
    <details
      open={!ingesteld}
      className={`rounded border p-4 ${ingesteld ? 'border-neutral-800' : 'border-amber-700/60 bg-amber-950/20'}`}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Nieuwe ClipArmy-campagnes automatisch ophalen{' '}
        <span className={ingesteld ? 'text-emerald-400' : 'text-amber-400'}>
          {ingesteld ? '(staat aan)' : '(staat uit — eenmalig instellen)'}
        </span>
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-neutral-400">
          De cloud haalt dan elk uur nieuwe campagnes op: je laptop hoeft niet aan te staan en je hoeft de site
          niet te bezoeken.
        </p>
        <p className="text-xs text-neutral-400">
          ClipArmy laadt zijn campagnes via een API-call, niet in de pagina zelf. Daarom plak je hier het
          verzoek dat je browser doet — mét het token dat erbij hoort.
        </p>
        <ol className="list-inside list-decimal space-y-1 text-xs text-neutral-400">
          <li>Open de campagnepagina op ClipArmy terwijl je ingelogd bent.</li>
          <li>
            Druk op F12 (of Cmd+Option+I) → tabblad <span className="text-neutral-300">Netwerk</span> → filter{' '}
            <span className="text-neutral-300">Fetch/XHR</span>.
          </li>
          <li>Ververs de pagina. Klik de regels langs tot je er een ziet met de campagnes erin (tab Preview/Respons).</li>
          <li>
            Rechtermuisknop op die regel →{' '}
            <span className="text-neutral-300">Kopiëren → Kopiëren als cURL</span>.
          </li>
          <li>Plak hem hieronder en bewaar.</li>
        </ol>
        <textarea
          value={curl}
          onChange={(e) => setCurl(e.target.value)}
          rows={4}
          placeholder="curl 'https://…/rest/v1/campaigns?select=*' -H 'authorization: Bearer …' …"
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => bewaar(curl)}
            disabled={busy || !curl.trim()}
            className="rounded border border-neutral-700 px-3 py-1.5 disabled:opacity-40"
          >
            {busy ? 'Bezig…' : 'Verzoek bewaren'}
          </button>
          {ingesteld && (
            <button onClick={() => bewaar('')} disabled={busy} className="text-xs text-neutral-500 hover:text-neutral-300">
              sessie wissen
            </button>
          )}
          {melding && <span className="text-neutral-400">{melding}</span>}
        </div>
        {ingesteld && (
          <p className="text-xs text-neutral-500">
            Laatste check: {laatsteCheck ? new Date(laatsteCheck).toLocaleString('nl-NL') : 'nog niet gedraaid'}
            {laatsteFout ? ` — ${laatsteFout}` : ''}
          </p>
        )}
        <p className="text-xs text-neutral-500">
          Het token verloopt vanzelf. Werkt het niet meer, dan zie je dat hierboven staan en plak je een vers
          verzoek.
        </p>
      </div>
    </details>
  );
}
