import { NextRequest, NextResponse } from 'next/server';
import { poortClient } from '@/lib/google-poort';

/** Uitloggen: de Google-sessie wordt bij Supabase ingetrokken en de cookies gewist. */
export async function POST(request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  // Cookie van het oude wachtwoordslot: opruimen bij wie hem nog heeft.
  response.cookies.set('session', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  try {
    await poortClient(request, response).auth.signOut();
  } catch {
    // Sessie was er niet of is al verlopen.
  }
  return response;
}
