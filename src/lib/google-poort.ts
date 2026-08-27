import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';
import { optionalEnv } from './env';

/**
 * De Google-poort: de buitenste van twee sloten op Clipper OS.
 *
 * Laag 1 (dit bestand) — Google-login via Supabase Auth. Wie hier niet
 * doorheen komt, ziet niets van de app.
 * Laag 2 — het bestaande e-mail/wachtwoord-systeem (app_users + sessions).
 *
 * Bewust twee GESCHEIDEN werelden: een Google-gebruiker leeft uitsluitend in
 * Supabase's eigen auth.users, en komt nooit in app_users terecht. Ze weten
 * niets van elkaar en delen geen tabel. Dat is precies de bedoeling: de poort
 * zegt alleen "jij mag het gebouw in", en laag 2 bepaalt daarna wie je bent en
 * wat je mag. Zou je ze koppelen, dan was één gecompromitteerd Google-account
 * meteen ook een app-account — dan hield je er feitelijk één slot aan over.
 */

/** Cookie waarin laag 2 zijn eigen sessie bewaart; hier alleen om ernaast te kijken. */
export const APP_SESSIE_COOKIE = 'session';

/**
 * Wie er door de poort mag. Komma-gescheiden e-mailadressen in
 * GOOGLE_TOEGANG_EMAILS. Staat de lijst leeg, dan mag elk Google-account door —
 * dan is de poort niet meer dan een drempel en leunt alles op laag 2.
 * Voor een interne tool hoort hier gewoon een lijst te staan.
 */
export function toegestaneEmails(): string[] {
  return optionalEnv('GOOGLE_TOEGANG_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function mailMagDoorDePoort(email: string | undefined | null): boolean {
  if (!email) return false;
  const lijst = toegestaneEmails();
  if (lijst.length === 0) return true;
  return lijst.includes(email.toLowerCase());
}

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
 * Staat er een geldige Google-sessie op dit verzoek, en mag dat adres erdoor?
 * Geeft het e-mailadres terug, of null.
 *
 * getUser() (niet getSession()) is hier bewust: die valideert de token bij
 * Supabase in plaats van een cookie op zijn woord te geloven — een cookie kan
 * de client zelf verzinnen.
 */
export async function googleGebruiker(
  request: NextRequest,
  response: NextResponse,
): Promise<string | null> {
  if (!optionalEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')) return null;

  try {
    const { data, error } = await poortClient(request, response).auth.getUser();
    if (error || !data.user?.email) return null;
    return mailMagDoorDePoort(data.user.email) ? data.user.email : null;
  } catch {
    return null;
  }
}
