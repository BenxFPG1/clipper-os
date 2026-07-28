import { NextRequest, NextResponse } from 'next/server';

/**
 * Toegangsslot op de hele site. Interne tool voor twee mensen, dus geen
 * accountsysteem (dat verbiedt de spec zelfs: "geen accounts/auth voor
 * derden") maar HTTP Basic Auth: de browser vraagt één keer om
 * gebruikersnaam/wachtwoord en stuurt die daarna automatisch mee.
 *
 * Zonder APP_PASSWORD (lokaal) staat de deur open; op Vercel staat hij erop.
 */
export function middleware(req: NextRequest) {
  const wachtwoord = process.env.APP_PASSWORD;
  if (!wachtwoord) return NextResponse.next();

  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Basic ')) {
    try {
      const [, pass] = atob(auth.slice(6)).split(':');
      if (pass === wachtwoord) return NextResponse.next();
    } catch {
      // ongeldig base64 → gewoon opnieuw vragen
    }
  }

  return new NextResponse('Inloggen vereist', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Clipper OS"' },
  });
}

export const config = {
  // Alles achter het slot behalve de statische assets van Next zelf.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
