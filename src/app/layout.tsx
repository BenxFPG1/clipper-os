import type { Metadata } from 'next';
import './globals.css';
import { Inhoud, Nav } from './nav';

export const metadata: Metadata = {
  title: 'Clipper OS',
  description: 'Van bronvideo naar clip-plan naar performance naar betere vault.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl">
      <body className="min-h-screen">
        <Nav />
        <Inhoud>{children}</Inhoud>
      </body>
    </html>
  );
}
