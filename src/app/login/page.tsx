'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
    <div className="min-h-screen flex flex-col items-center justify-center bg-white px-4 font-['Google_Sans',system-ui,-apple-system,sans-serif]">
      {/* Hoofd container - Google's exacte breedte */}
      <div className="w-full max-w-[448px]">

        {/* Google Logo - Exacte grootte */}
        <div className="flex justify-center mb-8">
          <svg width="75" height="75" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.99 23.99 0 0 0 0 24c0 3.77.87 7.35 2.56 10.56l7.97-5.97z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 5.97C6.51 42.62 14.62 48 24 48z"/>
          </svg>
        </div>

        {/* Titel - Exacte Google tekst */}
        <h1 className="text-center text-2xl font-medium text-[#202124] mb-1 tracking-[0.1px]">
          Sign in
        </h1>
        <p className="text-center text-base font-normal text-[#5f6368] mb-6">
          to continue to Clipper OS
        </p>

        {/* Error melding */}
        {error && (
          <div className="bg-[#fce8e6] border border-[#f5c6cb] text-[#d93025] px-4 py-2 rounded text-sm mb-4">
            {error}
          </div>
        )}

        {/* Formulier - Exacte Google stijl */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email veld - Exact Google */}
          <div className="relative">
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 pt-[22px] pb-[6px] border border-[#dadce0] rounded-[4px] focus:ring-2 focus:ring-[#1a73e8] focus:border-[#1a73e8] outline-none transition-all text-[16px] text-[#202124] peer"
              placeholder=" "
            />
            <label
              htmlFor="email"
              className="absolute left-4 top-1/2 -translate-y-1/2 text-[#5f6368] text-[16px] transition-all duration-200 pointer-events-none peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-focus:top-[6px] peer-focus:-translate-y-0 peer-focus:text-[12px] peer-focus:text-[#1a73e8]"
            >
              Email or phone
            </label>
          </div>

          {/* Wachtwoord veld - Exact Google */}
          <div className="relative">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 pt-[22px] pb-[6px] border border-[#dadce0] rounded-[4px] focus:ring-2 focus:ring-[#1a73e8] focus:border-[#1a73e8] outline-none transition-all text-[16px] text-[#202124] peer"
              placeholder=" "
            />
            <label
              htmlFor="password"
              className="absolute left-4 top-1/2 -translate-y-1/2 text-[#5f6368] text-[16px] transition-all duration-200 pointer-events-none peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-focus:top-[6px] peer-focus:-translate-y-0 peer-focus:text-[12px] peer-focus:text-[#1a73e8]"
            >
              Password
            </label>
          </div>

          {/* Forgot email - Exacte Google tekst */}
          <div className="text-left">
            <a
              href="#"
              className="text-[14px] text-[#1a73e8] font-medium hover:underline"
              onClick={(e) => {
                e.preventDefault();
                alert('Contact your administrator to reset your password.');
              }}
            >
              Forgot email?
            </a>
          </div>

          {/* Knoppen - Exacte Google layout */}
          <div className="flex items-center justify-between pt-2">
            <a
              href="#"
              className="text-[14px] text-[#1a73e8] font-medium hover:underline"
              onClick={(e) => {
                e.preventDefault();
                alert('Contact your administrator to create an account.');
              }}
            >
              Create account
            </a>
            <button
              type="submit"
              disabled={loading}
              className="py-[10px] px-[26px] bg-[#1a73e8] text-white font-medium rounded-full shadow-sm hover:bg-[#1557b0] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#1a73e8] transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed text-[14px] tracking-[0.25px]"
            >
              {loading ? 'Loading...' : 'Next'}
            </button>
          </div>
        </form>

        {/* Footer - Exacte Google layout */}
        <div className="mt-8 pt-4 border-t border-[#dadce0]">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#5f6368]">
            <div className="flex items-center gap-4">
              <span className="hover:underline cursor-default">English (United States)</span>
              <span className="w-px h-4 bg-[#dadce0]" />
              <span className="hover:underline cursor-default">Help</span>
            </div>
            <div className="flex items-center gap-4">
              <span className="hover:underline cursor-default">Privacy</span>
              <span className="w-px h-4 bg-[#dadce0]" />
              <span className="hover:underline cursor-default">Terms</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}