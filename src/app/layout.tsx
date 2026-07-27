import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Clipper OS',
  description: 'Van bronvideo naar clip-plan naar performance naar betere vault.',
};

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/videos', label: "Video's" },
  { href: '/opdrachten', label: 'Opdrachten' },
  { href: '/scout', label: 'Research' },
  { href: '/vault', label: 'Vault' },
  { href: '/performance', label: 'Performance' },
  { href: '/inbox', label: 'Agent-inbox' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl">
      <body className="min-h-screen">
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
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
