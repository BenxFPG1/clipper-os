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
      // Eerst proberen we in te loggen
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();

      if (!response.ok) {
        // Als inloggen faalt, proberen we te registreren
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

          // Account aangemaakt, nu direct inloggen
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

      // Ingelogd!
      router.push('/');
      router.refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="w-full max-w-[350px] px-4">
        {/* Google Logo */}
        <div className="flex justify-center mb-8">
          <svg className="w-20 h-20" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.99 23.99 0 0 0 0 24c0 3.77.87 7.35 2.56 10.56l7.97-5.97z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 5.97C6.51 42.62 14.62 48 24 48z"/>
          </svg>
        </div>

        {/* Titel - Exact zoals Google */}
        <h1 className="text-center text-2xl font-normal text-gray-700 mb-2">
          Log in
        </h1>
        <p className="text-center text-sm text-gray-500 mb-6">
          met je Clipper OS account
        </p>

        {/* Error melding */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-md text-sm mb-4">
            {error}
          </div>
        )}

        {/* Login Formulier - Google stijl */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email veld - Google stijl */}
          <div className="relative">
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-gray-700 text-base"
              placeholder=" "
            />
            <label
              htmlFor="email"
              className={`absolute left-4 top-3 text-gray-500 text-base transition-all duration-200 pointer-events-none ${
                email ? 'text-xs -translate-y-6 text-blue-600' : ''
              }`}
            >
              Email
            </label>
          </div>

          {/* Wachtwoord veld - Google stijl */}
          <div className="relative">
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-gray-700 text-base"
              placeholder=" "
            />
            <label
              htmlFor="password"
              className={`absolute left-4 top-3 text-gray-500 text-base transition-all duration-200 pointer-events-none ${
                password ? 'text-xs -translate-y-6 text-blue-600' : ''
              }`}
            >
              Wachtwoord
            </label>
          </div>

          {/* Vergeten wachtwoord link */}
          <div className="text-right">
            <a
              href="#"
              className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
              onClick={(e) => {
                e.preventDefault();
                alert('Neem contact op met de beheerder om je wachtwoord te resetten.');
              }}
            >
              Wachtwoord vergeten?
            </a>
          </div>

          {/* Login knop - Blauw zoals Google */}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-md shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? 'Bezig...' : 'Inloggen'}
          </button>
        </form>

        {/* Footer */}
        <div className="text-center mt-8">
          <p className="text-xs text-gray-400">
            Alleen voor intern gebruik • Clipper OS
          </p>
        </div>
      </div>
    </div>
  );
}