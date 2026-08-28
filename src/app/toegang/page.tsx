'use client';

import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

/**
 * De callback stuurt bij een afwijzing ?fout=... mee. Zonder vertaling zou de
 * gebruiker terugkomen op een schijnbaar normale inlogpagina zonder te weten
 * waarom hij niet binnenkwam.
 */
const FOUTTEKST: Record<string, string> = {
  'geen-toegang': 'Dit Google-account heeft geen toegang tot Clipper OS. Log in met een account dat toegang heeft.',
  'inloggen-mislukt': 'Inloggen bij Google is niet gelukt. Probeer het opnieuw.',
  'geen-code': 'De inlogpoging werd onderbroken. Probeer het opnieuw.',
};

/**
 * Laag 1 van twee: de Google-poort.
 *
 * Deze pagina heeft bewust maar één knop. Wie hier doorheen komt, belandt op
 * /login voor laag 2 (e-mail + wachtwoord). Pas daarna is de app open.
 */
export default function ToegangPage() {
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState('');

  // Foutcode uit de callback oppikken en meteen uit de URL halen, zodat een
  // ververste pagina niet blijft klagen over een poging van vijf minuten terug.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('fout');
    if (!code) return;
    setFout(FOUTTEKST[code] ?? 'Inloggen is niet gelukt. Probeer het opnieuw.');
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  async function metGoogle() {
    setBezig(true);
    setFout('');

    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        // Na Google komt de callback, en die stuurt door naar /login — het
        // tweede slot. De volgorde staat hier vast, niet in de URL.
        redirectTo: `${window.location.origin}/auth/callback`,
        // Zonder dit hergebruikt Google stilzwijgend het account waarmee je
        // daar al ingelogd bent. Word je met dat account geweigerd, dan kom je
        // in een lus: elke klik keurt hetzelfde account opnieuw goed, je wordt
        // opnieuw geweigerd, en je kunt nooit een ander account kiezen.
        queryParams: { prompt: 'select_account' },
      },
    });

    if (error) {
      setFout(error.message);
      setBezig(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Clipper OS</h1>
          <p className="mt-2 text-sm text-gray-600">Log eerst in met Google om verder te gaan.</p>
        </div>

        <button
          onClick={metGoogle}
          disabled={bezig}
          className="flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-white px-4 py-2.5 font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:opacity-50"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z"
            />
            <path
              fill="#EA4335"
              d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          {bezig ? 'Bezig…' : 'Inloggen met Google'}
        </button>

        {fout && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {fout}
          </div>
        )}

        <p className="text-center text-xs text-gray-400">
          <a href="/privacy" className="underline hover:text-gray-600">
            Privacybeleid
          </a>
          <span className="mx-2">·</span>
          <a href="/voorwaarden" className="underline hover:text-gray-600">
            Gebruiksvoorwaarden
          </a>
        </p>
      </div>
    </div>
  );
}
