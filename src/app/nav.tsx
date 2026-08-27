'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * De navigatie hoort niet op de inlogschermen: daar is nog niemand
 * binnengelaten, en een menu met alle onderdelen van de app verraadt de
 * structuur aan wie nog voor de deur staat (en levert links op die toch
 * allemaal terugsturen naar het inlogscherm).
 */
const VERBORGEN_OP = ['/toegang', '/login', '/register', '/auth'];

const NAV = [
  { href: '/', label: 'Dashboard' },
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
  if (VERBORGEN_OP.some((p) => pathname?.startsWith(p))) return null;

  return (
    <header className="border-b border-neutral-800">
      <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
        <span className="font-semibold tracking-tight">Clipper OS</span>
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} className="text-sm text-neutral-400 hover:text-neutral-100">
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

/** De inlogschermen brengen hun eigen volledige opmaak mee; die willen geen ingeperkte main-kolom. */
export function Inhoud({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const kaal = VERBORGEN_OP.some((p) => pathname?.startsWith(p));
  if (kaal) return <>{children}</>;
  return <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>;
}
