/**
 * Toegang: wie komt er na de Google-login in, en wie niet. Geen netwerk — de
 * ledenlijst (app_users) wordt nagebootst.
 */
let geslaagd = 0;
let totaal = 0;
function toets(naam: string, ok: boolean, detail = '') {
  totaal++;
  if (ok) geslaagd++;
  console.log(`  ${ok ? '✓' : '✗'} ${naam}${ok || !detail ? '' : ` — ${detail}`}`);
}

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://voorbeeld.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.ADMIN_EMAIL = '';
  process.env.GOOGLE_TOEGANG_EMAILS = '';
  let leden: unknown[] = [{ id: 'u1', email: 'Lid@Voorbeeld.nl', name: null, is_admin: true }];
  let stuk = false;
  globalThis.fetch = (async () => {
    if (stuk) throw new Error('database weg');
    return new Response(JSON.stringify(leden), { status: 200 });
  }) as typeof fetch;

  const { gebruikerVoor } = await import('../src/lib/toegang');

  console.log('toegangslijst');
  const lid = await gebruikerVoor('lid@voorbeeld.nl');
  toets('lid uit app_users komt erin, hoofdletters maken niet uit', lid?.id === 'u1' && lid.is_admin === true && lid.name === 'lid', JSON.stringify(lid));
  toets('zelfde adres met andere hoofdletters is dezelfde gebruiker (geen tweede account)', (await gebruikerVoor('LID@voorbeeld.NL'))?.id === 'u1');
  toets('onbekend adres komt er niet in', (await gebruikerVoor('vreemd@voorbeeld.nl')) === null);
  toets('leeg of ontbrekend adres komt er niet in', (await gebruikerVoor('')) === null && (await gebruikerVoor(null)) === null);

  process.env.GOOGLE_TOEGANG_EMAILS = ' Gast@Voorbeeld.nl , ';
  const gast = await gebruikerVoor('gast@voorbeeld.nl');
  toets('adres uit GOOGLE_TOEGANG_EMAILS komt erin, zonder adminrechten', gast !== null && gast.is_admin === false, JSON.stringify(gast));
  process.env.ADMIN_EMAIL = 'gast@voorbeeld.nl';
  toets('ADMIN_EMAIL maakt admin', (await gebruikerVoor('gast@voorbeeld.nl'))?.is_admin === true);

  // Lege lijsten: niemand. (Voorheen liet een lege lijst elk Google-account door.)
  process.env.GOOGLE_TOEGANG_EMAILS = '';
  process.env.ADMIN_EMAIL = '';
  toets('niet op de lijst en lege env: geweigerd', (await gebruikerVoor('gast@voorbeeld.nl')) === null);

  // Database onbereikbaar binnen de cacheduur: de vorige lijst blijft gelden.
  stuk = true;
  leden = [];
  toets('database even weg: bekende leden blijven binnen, vreemden buiten', (await gebruikerVoor('lid@voorbeeld.nl')) !== null && (await gebruikerVoor('vreemd@voorbeeld.nl')) === null);

  console.log(`${geslaagd}/${totaal} geslaagd`);
  if (geslaagd !== totaal) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
