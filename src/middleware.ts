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

/**
 * Routes met een eigen slot, die van buiten de browser aangeroepen worden:
 * de bookmarklet op cliparmy.nl stuurt hierheen zonder onze cookies (en de
 * browser doet eerst een OPTIONS-preflight zonder wélke cookie dan ook). Een
 * redirect naar /toegang laat die preflight stuklopen. Deze routes controleren
 * zelf de sleutel in x-clipper-sleutel; de middleware blijft eraf.
 */
const EIGEN_SLOT_ROUTES = ['/api/campaigns/import-extern', '/api/platform-sessie/extern'];

/** Bereikbaar zodra je door de Google-poort bent, maar nog niet ingelogd op je account. */
const NA_POORT_ROUTES = ['/login', '/register', '/api/auth/login', '/api/auth/register', '/api/auth/logout'];

const ADMIN_ROUTES = ['/admin'];

/**
 * Neemt de (eventueel vernieuwde) Google-cookies over op een andere response.
 *
 * Niet `headers: response.headers` gebruiken: NextResponse.next() draagt de
 * interne header x-middleware-next mee, en die zegt tegen Next "ga door naar
 * de route". Een 401 met die header erop werd daardoor genegeerd en de route
 * antwoordde gewoon 200 — precies het lek dat de middleware moet dichten.
 */
function metCookiesVan(bron: NextResponse, doel: NextResponse): NextResponse {
  for (const cookie of bron.cookies.getAll()) doel.cookies.set(cookie);
  return doel;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (EIGEN_SLOT_ROUTES.some((r) => pathname.startsWith(r))) {
    return NextResponse.next();
  }
  // Een preflight draagt nooit cookies; hem afwijzen zegt dus niets over de
  // gebruiker en breekt alleen de echte aanroep erna.
  if (request.method === 'OPTIONS') {
    return NextResponse.next();
  }

  const isPoortRoute = POORT_ROUTES.some((r) => pathname.startsWith(r));
  const isNaPoortRoute = NA_POORT_ROUTES.some((r) => pathname.startsWith(r));
  const isAdminRoute = ADMIN_ROUTES.some((r) => pathname.startsWith(r));
  const isApiRoute = pathname.startsWith('/api/');

  // De response waar de Google-client zijn (eventueel vernieuwde) cookies op
  // schrijft. Alles wat we hierna teruggeven moet die cookies overnemen,
  // anders gaat een net vernieuwde sessie verloren.
  const response = NextResponse.next();
  const redirect = (naar: URL) => metCookiesVan(response, NextResponse.redirect(naar));
  // Een fetch vanuit de app volgt een redirect stilzwijgend en krijgt dan de
  // HTML van de poortpagina terug; res.json() gooit en de knop blijft op
  // "Bezig…" hangen. Een API-aanroep krijgt daarom een 401 die de client
  // kan tonen.
  const nietIngelogd = () =>
    metCookiesVan(response, NextResponse.json({ error: 'Niet ingelogd — log opnieuw in.' }, { status: 401 }));

  // ---------------------------------------------------------------- laag 1
  const googleMail = await googleGebruiker(request, response);

  if (isPoortRoute) {
    // Al door de poort? Dan hoeft de poortpagina niet nog een keer.
    if (googleMail && pathname.startsWith('/toegang')) {
      return redirect(new URL('/login', request.url));
    }
    return response;
  }

  if (!googleMail) {
    if (isApiRoute) return nietIngelogd();
    return redirect(new URL('/toegang', request.url));
  }

  // ---------------------------------------------------------------- laag 2
  const user = await getUserFromCookies(request);

  if (!user && !isNaPoortRoute) {
    if (isApiRoute) return nietIngelogd();
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return redirect(loginUrl);
  }

  if (user && (pathname === '/login' || pathname === '/register')) {
    return redirect(new URL('/', request.url));
  }

  if (isAdminRoute && !user?.is_admin) {
    return redirect(new URL('/', request.url));
  }

  if (isApiRoute && user) {
    // Op de RÉQUEST-headers, zodat een API-route ze kan lezen met
    // req.headers.get('x-user-id'). Op de response zag alleen de browser ze.
    // Een waarde die de client zelf meestuurt wordt hier overschreven, dus
    // routes mogen erop vertrouwen.
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-user-id', user.id);
    requestHeaders.set('x-user-email', user.email);
    requestHeaders.set('x-is-admin', String(user.is_admin));
    return metCookiesVan(response, NextResponse.next({ request: { headers: requestHeaders } }));
  }

  return response;
}

export const config = {
  // Statische bestanden overslaan: elke run kost een tokencheck bij Supabase
  // plus een sessiequery, en een plaatje of font hoeft niet bewaakt te worden.
  // Let op: geen (?:…)-groepen in deze regex — path-to-regexp leest die
  // verkeerd en dan valt /api/* buiten de middleware.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$|.*\\.jpeg$|.*\\.gif$|.*\\.svg$|.*\\.ico$|.*\\.webp$|.*\\.woff$|.*\\.woff2$|.*\\.ttf$|.*\\.css$|.*\\.js$|.*\\.map$|.*\\.txt$|.*\\.xml$).*)',
  ],
};
