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
const VERBORGEN_OP = ['/toegang', '/auth', '/privacy', '/voorwaarden'];

/**
 * De hoofdroute, in de volgorde waarin je werkt: video erin, clips maken,
 * beoordelen, posten en de cijfers bekijken.
 */
const NAV = [
  { href: '/', label: 'Start' },
  { href: '/videos', label: "Video's" },
  { href: '/beoordelen', label: 'Beoordelen' },
  { href: '/performance', label: 'Resultaten' },
];

/** Alles wat je niet dagelijks nodig hebt. */
const MEER = [
  { href: '/opdrachten', label: 'Opdrachten', uitleg: 'briefings en scripts voor nieuwe opnames' },
  { href: '/scout', label: 'Research', uitleg: 'accounts en zoektermen die de tool volgt' },
  { href: '/outliers', label: 'Uitschieters', uitleg: 'posts van anderen die opvallend goed gingen' },
  { href: '/vault', label: 'Kennisbank', uitleg: 'regels en lessen die de tool gebruikt' },
  { href: '/inbox', label: 'Voorstellen', uitleg: 'wijzigingen die op jouw akkoord wachten' },
  { href: '/instellingen', label: 'Instellingen', uitleg: 'ClipArmy-koppeling, verbruik en leerstand' },
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
        {NAV.map((item) => {
          const actief = item.href === '/' ? pathname === '/' : pathname?.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`text-sm hover:text-neutral-100 ${actief ? 'text-neutral-100' : 'text-neutral-400'}`}
            >
              {item.label}
              {item.href === '/beoordelen' && teBeoordelen !== null && teBeoordelen > 0 && (
                <span className="ml-1 rounded-full bg-amber-400 px-1.5 text-xs font-medium text-neutral-900">{teBeoordelen}</span>
              )}
            </Link>
          );
        })}
        <details key={pathname} className="group relative">
          <summary
            className={`cursor-pointer list-none text-sm hover:text-neutral-100 ${
              MEER.some((m) => pathname?.startsWith(m.href)) ? 'text-neutral-100' : 'text-neutral-400'
            }`}
          >
            Meer ▾
          </summary>
          <div className="absolute left-0 z-20 mt-2 w-72 rounded border border-neutral-800 bg-neutral-950 p-1 shadow-xl">
            {MEER.map((item) => (
              <Link key={item.href} href={item.href} className="block rounded px-3 py-2 hover:bg-neutral-900">
                <span className="text-sm text-neutral-100">{item.label}</span>
                <span className="block text-xs text-neutral-500">{item.uitleg}</span>
              </Link>
            ))}
          </div>
        </details>
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
 * Logt uit bij Google en zet je
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
