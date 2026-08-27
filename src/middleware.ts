import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getUserFromCookies } from './lib/auth';
import { googleGebruiker } from './lib/google-poort';

/**
 * Twee sloten, in vaste volgorde.
 *
 * Laag 1 — Google (/toegang): wie hier niet doorheen komt ziet niets, ook geen
 *   inlogformulier van laag 2.
 * Laag 2 — het eigen account (/login): bepaalt wie je bent en of je admin bent.
 *
 * De twee systemen staan los van elkaar: de Google-gebruiker leeft in Supabase
 * Auth, het account in app_users. Ze delen geen tabel en weten niets van
 * elkaar.
 */

/**
 * Alleen dit is bereikbaar zónder Google-sessie.
 *
 * /privacy en /voorwaarden staan er bewust bij: Google eist dat een
 * OAuth-app een bereikbaar privacybeleid en gebruiksvoorwaarden heeft
 * voordat hij gepubliceerd mag worden. Achter de poort zijn ze voor Google
 * onzichtbaar en blijft de app in testmodus hangen.
 */
const POORT_ROUTES = ['/toegang', '/auth/callback', '/privacy', '/voorwaarden'];

/** Bereikbaar zodra je door de Google-poort bent, maar nog niet ingelogd op je account. */
const NA_POORT_ROUTES = ['/login', '/register', '/api/auth/login', '/api/auth/register'];

const ADMIN_ROUTES = ['/admin'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isPoortRoute = POORT_ROUTES.some((r) => pathname.startsWith(r));
  const isNaPoortRoute = NA_POORT_ROUTES.some((r) => pathname.startsWith(r));
  const isAdminRoute = ADMIN_ROUTES.some((r) => pathname.startsWith(r));
  const isApiRoute = pathname.startsWith('/api/');

  // De response waar de Google-client zijn (eventueel vernieuwde) cookies op
  // schrijft. Alles wat we hierna teruggeven moet hierop voortbouwen, anders
  // gaat een net vernieuwde sessie verloren.
  const response = NextResponse.next();

  // ---------------------------------------------------------------- laag 1
  const googleMail = await googleGebruiker(request, response);

  if (isPoortRoute) {
    // Al door de poort? Dan hoeft de poortpagina niet nog een keer.
    if (googleMail && pathname.startsWith('/toegang')) {
      return NextResponse.redirect(new URL('/login', request.url), { headers: response.headers });
    }
    return response;
  }

  if (!googleMail) {
    const naarToegang = NextResponse.redirect(new URL('/toegang', request.url), {
      headers: response.headers,
    });
    return naarToegang;
  }

  // ---------------------------------------------------------------- laag 2
  const user = await getUserFromCookies(request);

  if (!user && !isNaPoortRoute) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl, { headers: response.headers });
  }

  if (user && (pathname === '/login' || pathname === '/register')) {
    return NextResponse.redirect(new URL('/', request.url), { headers: response.headers });
  }

  if (isAdminRoute && !user?.is_admin) {
    return NextResponse.redirect(new URL('/', request.url), { headers: response.headers });
  }

  if (isApiRoute && user) {
    response.headers.set('x-user-id', user.id);
    response.headers.set('x-user-email', user.email);
    response.headers.set('x-is-admin', String(user.is_admin));
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
