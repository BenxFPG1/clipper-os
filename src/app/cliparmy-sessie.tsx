'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * ClipArmy automatisch laten ophalen zodat de cloud zelf nieuwe campagnes
 * binnenhaalt — ook als je laptop dicht is.
 *
 * De aanbevolen route is een e-mailcode: die werkt ook met een Google-account
 * (dat geen wachtwoord heeft) en maakt een eigen sessie voor de cloud aan, los
 * van je browser. Er wordt nooit een wachtwoord bewaard; intrekken kan door
 * bij ClipArmy overal uit te loggen.
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
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeGestuurd, setCodeGestuurd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  async function otp(actie: 'start' | 'verify') {
    setBusy(true);
    setMelding(null);
    const res = await fetch('/api/platform-sessie/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actie, email: email.trim(), code }),
    });
    const uit = (await res.json()) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setMelding(uit.error ?? 'Mislukt');
      return;
    }
    if (actie === 'start') {
      setCodeGestuurd(true);
      setMelding('Code verstuurd — kijk in je mail (ook spam).');
    } else {
      setCode('');
      setCodeGestuurd(false);
      setMelding('Gekoppeld. De cloud haalt vanaf nu elk uur zelf nieuwe campagnes op.');
      router.refresh();
    }
  }

  async function bewaarCurl(waarde: string) {
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
    setMelding(waarde ? `Bewaard (${uit.verzoek}). Koppel nu hierboven met de e-mailcode.` : 'Sessie gewist.');
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

        <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3">
          <p className="mb-2 text-sm font-medium">Koppelen met een e-mailcode (werkt ook met Google-login)</p>
          <p className="mb-2 text-xs text-neutral-400">
            ClipArmy mailt je een inlogcode of -link; die plak je hier. Clipper OS krijgt daarmee een eigen sessie die
            zichzelf elk uur ververst — los van je browser, dus je wordt nergens uitgelogd. Geen wachtwoord
            nodig.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e-mail van je ClipArmy-account"
              className="w-64 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs"
            />
            <button
              onClick={() => otp('start')}
              disabled={busy || !email.includes('@')}
              className="rounded border border-neutral-700 px-3 py-1.5 text-xs disabled:opacity-40"
            >
              {busy && !codeGestuurd ? 'Bezig…' : 'Stuur code'}
            </button>
          </div>
          {codeGestuurd && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="code of inloglink uit de e-mail"
                className="w-40 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono text-xs"
              />
              <button
                onClick={() => otp('verify')}
                disabled={busy || code.trim().length < 4}
                className="rounded bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 disabled:opacity-40"
              >
                Koppelen
              </button>
            </div>
          )}
        </div>

        <details className="rounded border border-neutral-800 p-3">
          <summary className="cursor-pointer text-xs text-neutral-500">
            Eenmalige voorbereiding of terugval: cURL-verzoek plakken
          </summary>
          <div className="mt-2 space-y-2">
            <p className="text-xs text-neutral-500">
              De e-mailcode heeft één keer het adres en de publieke sleutel van ClipArmy nodig; die halen we
              uit een geplakt verzoek. Staat de koppeling al op &quot;aan&quot; geweest, dan is dit al gebeurd
              en hoef je hier niets.
            </p>
            <ol className="list-inside list-decimal space-y-1 text-xs text-neutral-500">
              <li>Open de campagnepagina op ClipArmy, ingelogd.</li>
              <li>F12 → Netwerk → filter Fetch/XHR → ververs.</li>
              <li>Zoek de regel met de campagnes (Preview) → rechtermuisknop → Kopiëren als cURL.</li>
              <li>Plak hieronder.</li>
            </ol>
            <textarea
              value={curl}
              onChange={(e) => setCurl(e.target.value)}
              rows={3}
              placeholder="curl 'https://…/rest/v1/…' -H 'authorization: Bearer …' …"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => bewaarCurl(curl)}
                disabled={busy || !curl.trim()}
                className="rounded border border-neutral-700 px-3 py-1.5 text-xs disabled:opacity-40"
              >
                {busy ? 'Bezig…' : 'Verzoek bewaren'}
              </button>
              {ingesteld && (
                <button
                  onClick={() => bewaarCurl('')}
                  disabled={busy}
                  className="text-xs text-neutral-500 hover:text-neutral-300"
                >
                  sessie wissen
                </button>
              )}
            </div>
          </div>
        </details>

        {melding && <p className="text-neutral-300">{melding}</p>}
        {ingesteld && (
          <p className="text-xs text-neutral-500">
            Laatste check: {laatsteCheck ? new Date(laatsteCheck).toLocaleString('nl-NL') : 'nog niet gedraaid'}
            {laatsteFout ? ` — ${laatsteFout}` : ''}
          </p>
        )}
      </div>
    </details>
  );
}
