'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * ClipArmy-sessie instellen zodat de cloud zelf nieuwe campagnes ophaalt —
 * ook als je laptop dicht is.
 *
 * Waarom een cookie en niet je wachtwoord: een wachtwoord geeft volledige
 * toegang tot je account (aankopen, wachtwoord wijzigen) en zou in onze
 * database staan. Een sessiecookie is beperkt tot lezen wat jij ook ziet,
 * verloopt vanzelf, en je trekt hem in door op ClipArmy uit te loggen.
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
  const [cookie, setCookie] = useState('');
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  async function bewaar(waarde: string) {
    setBusy(true);
    setMelding(null);
    const res = await fetch('/api/platform-sessie', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'cliparmy', cookie: waarde }),
    });
    setBusy(false);
    setMelding(res.ok ? (waarde ? 'Sessie bewaard. De cloud checkt vanaf nu elk uur.' : 'Sessie gewist.') : 'Opslaan mislukt');
    setCookie('');
    router.refresh();
  }

  return (
    <details className="rounded border border-neutral-800 p-4">
      <summary className="cursor-pointer text-sm text-neutral-400">
        ClipArmy automatisch ophalen {ingesteld ? '(aan)' : '(uit)'}
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-neutral-400">
          Met een sessiecookie haalt de cloud elk uur nieuwe campagnes op — je laptop hoeft niet aan te staan en
          je hoeft de site niet te bezoeken.
        </p>
        <ol className="list-inside list-decimal space-y-1 text-xs text-neutral-400">
          <li>Open cliparmy.nl in Chrome terwijl je ingelogd bent.</li>
          <li>Druk op F12 (of Cmd+Option+I) → tabblad <span className="text-neutral-300">Network</span>.</li>
          <li>Ververs de pagina, klik de bovenste regel aan.</li>
          <li>
            Zoek bij <span className="text-neutral-300">Request Headers</span> de regel{' '}
            <code className="text-neutral-300">cookie:</code> en kopieer de hele waarde erachter.
          </li>
          <li>Plak hem hieronder.</li>
        </ol>
        <textarea
          value={cookie}
          onChange={(e) => setCookie(e.target.value)}
          rows={3}
          placeholder="sb-access-token=…; sb-refresh-token=…"
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => bewaar(cookie)}
            disabled={busy || !cookie.trim()}
            className="rounded border border-neutral-700 px-3 py-1.5 disabled:opacity-40"
          >
            {busy ? 'Bezig…' : 'Sessie bewaren'}
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
          Een sessiecookie verloopt vanzelf (meestal na een paar weken). Werkt het niet meer, dan zie je dat
          hierboven en plak je een verse.
        </p>
      </div>
    </details>
  );
}
