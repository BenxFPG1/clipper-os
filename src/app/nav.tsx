'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { roepApiAan } from './api-aanroep';

/**
 * De navigatie hoort niet op de inlogschermen: daar is nog niemand
 * binnengelaten, en een menu met alle onderdelen van de app verraadt de
 * structuur aan wie nog voor de deur staat (en levert links op die toch
 * allemaal terugsturen naar het inlogscherm).
 */
const VERBORGEN_OP = ['/toegang', '/login', '/register', '/auth', '/privacy', '/voorwaarden'];

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/beoordelen', label: 'Beoordelen' },
  { href: '/videos', label: "Video's" },
  { href: '/opdrachten', label: 'Opdrachten' },
  { href: '/outliers', label: 'Outliers' },
  { href: '/scout', label: 'Research' },
  { href: '/vault', label: 'Vault' },
  { href: '/performance', label: 'Performance' },
  { href: '/inbox', label: 'Agent-inbox' },
];

export function Nav() {
  const pathname = usePathname();
  const verborgen = VERBORGEN_OP.some((p) => pathname?.startsWith(p));
  const teBeoordelen = useTeBeoordelen(verborgen ? null : pathname);
  if (verborgen) return null;

  return (
    <header className="border-b border-neutral-800">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
        <span className="font-semibold tracking-tight">Clipper OS</span>
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} className="text-sm text-neutral-400 hover:text-neutral-100">
            {item.label}
            {item.href === '/beoordelen' && teBeoordelen !== null && (
              <span className={teBeoordelen > 0 ? 'text-amber-300' : ''}> ({teBeoordelen})</span>
            )}
          </Link>
        ))}
        <UitlogKnop />
      </nav>
    </header>
  );
}

/**
 * Aantal renders dat nog op een oordeel wacht, ververst bij elke paginawissel
 * (na een ronde beoordelen klopt het getal dan meteen). Faalt het, dan geen
 * getal in plaats van een verkeerd getal.
 */
function useTeBeoordelen(pathname: string | null): number | null {
  const [aantal, setAantal] = useState<number | null>(null);
  useEffect(() => {
    if (!pathname) return;
    let weg = false;
    void roepApiAan<{ totaal?: number }>('/api/beoordelen?alleen_aantal=1').then(({ ok, json }) => {
      if (!weg) setAantal(ok && typeof json.totaal === 'number' ? json.totaal : null);
    });
    return () => {
      weg = true;
    };
  }, [pathname]);
  return aantal;
}

/**
 * Beëindigt beide sloten tegelijk (app-sessie én Google-sessie) en zet je
 * weer voor de deur. Zonder deze knop was de enige uitweg cookies wissen.
 */
function UitlogKnop() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function uitloggen() {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ook als het verzoek mislukt sturen we door: de middleware wijst
      // een sessie die niet meer klopt toch af.
    } finally {
      setBusy(false);
      router.push('/toegang');
      router.refresh();
    }
  }

  return (
    <button
      onClick={uitloggen}
      disabled={busy}
      className="ml-auto text-sm text-neutral-500 hover:text-neutral-200 disabled:opacity-40"
      title="Uitloggen"
    >
      {busy ? 'Bezig…' : 'Uitloggen'}
    </button>
  );
}

/** De inlogschermen brengen hun eigen volledige opmaak mee; die willen geen ingeperkte main-kolom. */
export function Inhoud({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const kaal = VERBORGEN_OP.some((p) => pathname?.startsWith(p));
  if (kaal) return <>{children}</>;
  return <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>;
}
