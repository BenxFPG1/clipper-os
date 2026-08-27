'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();

      if (!response.ok) {
        if (data.error?.includes('niet gevonden') || data.error?.includes('Ongeldige')) {
          const registerResponse = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, name: email.split('@')[0], password })
          });

          const registerData = await registerResponse.json();

          if (!registerResponse.ok) {
            throw new Error(registerData.error || 'Account aanmaken mislukt');
          }

          const loginResponse = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });

          const loginData = await loginResponse.json();

          if (!loginResponse.ok) {
            throw new Error(loginData.error || 'Inloggen na registratie mislukt');
          }

          router.push('/');
          router.refresh();
          return;
        }

        throw new Error(data.error || 'Inloggen mislukt');
      }

      router.push('/');
      router.refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white px-4">
      {/* Hoofd container - Exacte Google breedte */}
      <div className="w-full max-w-[448px]">

        {/* Google Logo */}
        <div className="flex justify-center mb-8">
          <svg className="w-[72px] h-[72px]" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.99 23.99 0 0 0 0 24c0 3.77.87 7.35 2.56 10.56l7.97-5.97z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 5.97C6.51 42.62 14.62 48 24 48z"/>
          </svg>
        </div>

        {/* Titel - Nederlands */}
        <h1 className="text-center text-2xl font-normal text-gray-800 mb-1">
          Inloggen
        </h1>
        <p className="text-center text-base text-gray-600 mb-6">
          om door te gaan naar Clipper OS
        </p>

        {/* Error melding */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm mb-4">
            {error}
          </div>
        )}

        {/* Formulier - Exacte Google stijl */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email veld */}
          <div className="relative">
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 pt-5 pb-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-gray-700 text-base peer"
              placeholder=" "
            />
            <label
              htmlFor="email"
              className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 text-base transition-all duration-200 pointer-events-none peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-focus:top-2 peer-focus:-translate-y-0 peer-focus:text-xs peer-focus:text-blue-600"
            >
              E-mailadres of telefoonnummer
            </label>
          </div>

          {/* Wachtwoord veld */}
          <div className="relative">
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 pt-5 pb-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-gray-700 text-base peer"
              placeholder=" "
            />
            <label
              htmlFor="password"
              className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 text-base transition-all duration-200 pointer-events-none peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-focus:top-2 peer-focus:-translate-y-0 peer-focus:text-xs peer-focus:text-blue-600"
            >
              Wachtwoord
            </label>
          </div>

          {/* Vergeten email link */}
          <div className="text-left">
            <a
              href="#"
              className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
              onClick={(e) => {
                e.preventDefault();
                alert('Neem contact op met de beheerder.');
              }}
            >
              E-mailadres vergeten?
            </a>
          </div>

          {/* Knoppen - Exact zoals Google */}
          <div className="flex items-center justify-between pt-2">
            <a
              href="#"
              className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
              onClick={(e) => {
                e.preventDefault();
                alert('Neem contact op met de beheerder.');
              }}
            >
              Account aanmaken
            </a>
            <button
              type="submit"
              disabled={loading}
              className="py-2 px-6 bg-blue-600 text-white font-medium rounded-full shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed text-sm"
            >
              {loading ? 'Bezig...' : 'Volgende'}
            </button>
          </div>
        </form>

        {/* Footer - Nederlands */}
        <div className="mt-8 pt-6 border-t border-gray-200">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
            <div className="flex items-center gap-4">
              <span>Nederlands (Nederland)</span>
              <span className="w-px h-4 bg-gray-300" />
              <span>Help</span>
            </div>
            <div className="flex items-center gap-4">
              <span>Privacy</span>
              <span className="w-px h-4 bg-gray-300" />
              <span>Voorwaarden</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}