import type { Metadata } from 'next';
import './globals.css';
import { Inhoud, Nav } from './nav';

export const metadata: Metadata = {
  title: 'Clipper OS',
  description: 'Interne clipping tool voor clipping workflow',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=yes" />
        <meta name="theme-color" content="#ffffff" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
      </head>
      {/*
        Geen bg-white hier: de app is donker (globals.css). De inlogschermen
        brengen hun eigen witte opmaak mee en Nav/Inhoud blijven daar weg.
      */}
      <body className="min-h-screen antialiased">
        <Nav />
        <Inhoud>{children}</Inhoud>
      </body>
    </html>
  );
}
