import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getUserFromCookies } from './lib/auth';

// Publieke routes (geen login nodig)
const PUBLIC_ROUTES = [
  '/login',
  '/register',
  '/api/auth/login',
  '/api/auth/register'
];

// Admin-only routes
const ADMIN_ROUTES = [
  '/admin'
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check of route publiek is
  const isPublic = PUBLIC_ROUTES.some(route => pathname.startsWith(route));
  const isAdminRoute = ADMIN_ROUTES.some(route => pathname.startsWith(route));
  const isApiRoute = pathname.startsWith('/api/');

  // Haal gebruiker op uit cookies (via JWT token)
  const user = await getUserFromCookies(request);

  // Als niet ingelogd en geen publieke route -> redirect naar login
  if (!user && !isPublic) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Als ingelogd en op login/register pagina -> redirect naar dashboard
  if (user && (pathname === '/login' || pathname === '/register')) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  // Admin route check
  if (isAdminRoute && !user?.is_admin) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  // API route: voeg user info toe aan headers (handig voor API calls)
  if (isApiRoute && user) {
    const response = NextResponse.next();
    response.headers.set('x-user-id', user.id);
    response.headers.set('x-user-email', user.email);
    response.headers.set('x-is-admin', String(user.is_admin));
    return response;
  }

  return NextResponse.next();
}

export const config = {
  // Alles behalve Next.js eigen statische bestanden
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};