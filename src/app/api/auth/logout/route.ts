import { NextRequest, NextResponse } from 'next/server';
import { deleteSession } from '@/lib/auth';
import { APP_SESSIE_COOKIE, poortClient } from '@/lib/google-poort';

/**
 * Uitloggen uit beide sloten tegelijk: de app-sessie (laag 2) gaat uit de
 * tabel en de cookie wordt geleegd; de Google-sessie (laag 1) wordt bij
 * Supabase ingetrokken en zijn cookies worden op dezelfde response gewist.
 * Alleen laag 2 wissen zou je meteen weer op /login zetten in plaats van
 * voor de deur.
 */
export async function POST(request: NextRequest) {
  const response = NextResponse.json({ ok: true });

  const sessionId = request.cookies.get(APP_SESSIE_COOKIE)?.value;
  if (sessionId) {
    await deleteSession(sessionId).catch(() => undefined);
  }
  response.cookies.set(APP_SESSIE_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });

  try {
    await poortClient(request, response).auth.signOut();
  } catch {
    // Google-sessie was er niet of is al verlopen; de app-sessie is hoe dan ook weg.
  }

  return response;
}
