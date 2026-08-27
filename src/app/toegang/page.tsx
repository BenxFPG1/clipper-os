'use client';

import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

/**
 * Laag 1 van twee: de Google-poort.
 *
 * Deze pagina heeft bewust maar één knop. Wie hier doorheen komt, belandt op
 * /login voor laag 2 (e-mail + wachtwoord). Pas daarna is de app open.
 */
export default function ToegangPage() {
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState('');

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

        {fout && <p className="text-center text-sm text-red-600">{fout}</p>}
      </div>
    </div>
  );
}
