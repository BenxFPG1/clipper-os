import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';
import { optionalEnv } from './env';
import { gebruikerVoor, type Gebruiker } from './toegang';

/**
 * De Google-login: het enige slot op Clipper OS.
 *
 * Inloggen gaat via Supabase Auth met Google. Wie daarna op de toegangslijst
 * staat (src/lib/toegang.ts) is binnen; alle anderen zien niets van de app.
 */

/**
 * Supabase-client die zijn sessie in de cookies van dit verzoek bewaart.
 * De meegegeven response krijgt de bijgewerkte cookies mee terug — zonder dat
 * vervalt de sessie bij de eerstvolgende tokenvernieuwing.
 */
export function poortClient(request: NextRequest, response: NextResponse) {
  return createServerClient(
    optionalEnv('NEXT_PUBLIC_SUPABASE_URL'),
    optionalEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) => {
          for (const { name, value, options } of cookies) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );
}

/**
 * Staat er een geldige Google-sessie op dit verzoek, en heeft dat adres toegang?
 *
 * getUser() (niet getSession()) is hier bewust: die valideert de token bij
 * Supabase in plaats van een cookie op zijn woord te geloven — een cookie kan
 * de client zelf verzinnen.
 */
export async function ingelogdeGebruiker(request: NextRequest, response: NextResponse): Promise<Gebruiker | null> {
  // Alleen bij lokaal ontwikkelen (next dev): de pagina's bekijken zonder
  // Google-ronde. Het adres moet nog steeds op de toegangslijst staan, en in
  // een productie-build bestaat deze tak niet.
  if (process.env.NODE_ENV === 'development' && process.env.DEV_GEBRUIKER) {
    return gebruikerVoor(process.env.DEV_GEBRUIKER);
  }
  if (!optionalEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')) return null;
  try {
    const { data, error } = await poortClient(request, response).auth.getUser();
    if (error || !data.user?.email) return null;
    return await gebruikerVoor(data.user.email);
  } catch {
    return null;
  }
}
