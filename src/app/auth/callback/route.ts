import { NextRequest, NextResponse } from 'next/server';
import { mailMagDoorDePoort, poortClient } from '@/lib/google-poort';

/**
 * Waar Google op terugkomt. Wisselt de eenmalige code in voor een sessie en
 * stuurt door naar /login — het tweede slot.
 *
 * Wie niet op de toegangslijst staat wordt hier meteen weer uitgelogd: anders
 * zou de sessie blijven staan en de poort bij elk verzoek opnieuw "nee" moeten
 * zeggen tegen een geldig ingelogde gebruiker.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const foutVanGoogle = url.searchParams.get('error_description') ?? url.searchParams.get('error');

  if (foutVanGoogle) {
    return NextResponse.redirect(new URL(`/toegang?fout=${encodeURIComponent(foutVanGoogle)}`, url.origin));
  }
  if (!code) {
    return NextResponse.redirect(new URL('/toegang?fout=geen-code', url.origin));
  }

  // De response maken we vooraf: de Supabase-client schrijft zijn
  // sessiecookies erop, en precies díe response moeten we teruggeven.
  const response = NextResponse.redirect(new URL('/login', url.origin));
  const supabase = poortClient(request, response);

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user?.email) {
    return NextResponse.redirect(new URL('/toegang?fout=inloggen-mislukt', url.origin));
  }

  if (!mailMagDoorDePoort(data.user.email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL('/toegang?fout=geen-toegang', url.origin));
  }

  return response;
}
