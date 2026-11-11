import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ingelogdeGebruiker } from './lib/google-poort';

/**
 * Eén slot: inloggen met Google, en op de toegangslijst staan
 * (src/lib/toegang.ts). Alles behalve de routes hieronder zit erachter.
 */

/**
 * Bereikbaar zonder in te loggen.
 *
 * /privacy en /voorwaarden staan er bewust bij: Google eist dat een
 * OAuth-app een bereikbaar privacybeleid en gebruiksvoorwaarden heeft
 * voordat hij gepubliceerd mag worden.
 */
const OPEN_ROUTES = ['/toegang', '/auth/callback', '/privacy', '/voorwaarden'];

/**
 * Routes met een eigen slot, die van buiten de browser aangeroepen worden:
 * de bookmarklet op cliparmy.nl stuurt hierheen zonder onze cookies (en de
 * browser doet eerst een OPTIONS-preflight zonder wélke cookie dan ook). Deze
 * routes controleren zelf de sleutel in x-clipper-sleutel.
 */
const EIGEN_SLOT_ROUTES = ['/api/campaigns/import-extern', '/api/platform-sessie/extern'];

const begintMet = (pad: string, routes: string[]) => routes.some((r) => pad === r || pad.startsWith(`${r}/`));

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

  if (begintMet(pathname, EIGEN_SLOT_ROUTES)) return NextResponse.next();
  // Een preflight draagt nooit cookies; hem afwijzen zegt dus niets over de
  // gebruiker en breekt alleen de echte aanroep erna.
  if (request.method === 'OPTIONS') return NextResponse.next();

  const isApiRoute = pathname.startsWith('/api/');

  // Een andere site mag namens een ingelogde gebruiker niets wijzigen of
  // starten. De browser stuurt bij zo'n verzoek zijn eigen Origin mee.
  if (isApiRoute && !['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== request.nextUrl.host) {
      return NextResponse.json({ error: 'Verzoek van een andere site geweigerd.' }, { status: 403 });
    }
  }

  // De response waar de Google-client zijn (eventueel vernieuwde) cookies op
  // schrijft. Alles wat we hierna teruggeven moet die cookies overnemen,
  // anders gaat een net vernieuwde sessie verloren.
  const response = NextResponse.next();
  const redirect = (naar: URL) => metCookiesVan(response, NextResponse.redirect(naar));

  const gebruiker = await ingelogdeGebruiker(request, response);

  if (begintMet(pathname, OPEN_ROUTES)) {
    // Al binnen? Dan hoeft de inlogpagina niet nog een keer.
    if (gebruiker && begintMet(pathname, ['/toegang'])) return redirect(new URL('/', request.url));
    return response;
  }

  if (!gebruiker) {
    // Een fetch vanuit de app volgt een redirect stilzwijgend en krijgt dan de
    // HTML van de inlogpagina terug; res.json() gooit en de knop blijft op
    // "Bezig…" hangen. Een API-aanroep krijgt daarom een 401 die de client
    // kan tonen.
    if (isApiRoute) {
      return metCookiesVan(response, NextResponse.json({ error: 'Niet ingelogd — log opnieuw in.' }, { status: 401 }));
    }
    return redirect(new URL('/toegang', request.url));
  }

  // Op de RÉQUEST-headers, zodat routes en pagina's ze kunnen lezen. Een
  // waarde die de client zelf meestuurt wordt hier overschreven, dus routes
  // mogen erop vertrouwen.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-user-id', gebruiker.id);
  requestHeaders.set('x-user-email', gebruiker.email);
  requestHeaders.set('x-user-name', gebruiker.name);
  requestHeaders.set('x-is-admin', String(gebruiker.is_admin));
  return metCookiesVan(response, NextResponse.next({ request: { headers: requestHeaders } }));
}

export const config = {
  // Statische bestanden overslaan: elke run kost een tokencheck bij Supabase.
  // /api staat er apart bij: de extensie-uitzondering hieronder liet anders
  // /api/clips/<id>.js zonder controle door.
  // Let op: geen (?:…)-groepen in deze regex — path-to-regexp leest die
  // verkeerd en dan valt /api/* buiten de middleware.
  matcher: [
    '/api/:path*',
    '/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$|.*\\.jpeg$|.*\\.gif$|.*\\.svg$|.*\\.ico$|.*\\.webp$|.*\\.woff$|.*\\.woff2$|.*\\.ttf$|.*\\.css$|.*\\.js$|.*\\.map$|.*\\.txt$|.*\\.xml$).*)',
  ],
};
