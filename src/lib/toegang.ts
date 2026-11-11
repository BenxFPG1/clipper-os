import { optionalEnv } from './env';

/**
 * Wie mag Clipper OS in, en wie is admin?
 *
 * Er is één slot: inloggen met Google (Supabase Auth). Daarna beslist deze
 * lijst. Een wachtwoord van onszelf bestaat niet meer — het vorige systeem
 * bewaarde wachtwoorden leesbaar in een tabel die met de publieke sleutel te
 * lezen was.
 *
 * De lijst komt uit twee bronnen, samengevoegd:
 *  - GOOGLE_TOEGANG_EMAILS (komma-gescheiden), en
 *  - de tabel app_users (e-mail + is_admin), zodat een lid toevoegen geen
 *    nieuwe deploy vraagt.
 * Staat een adres in geen van beide, dan komt het er niet in. Een lege lijst
 * laat dus niemand door (voorheen: iedereen).
 */

export type Gebruiker = { id: string; email: string; name: string; is_admin: boolean };

type Lid = { id: string; email: string; name: string | null; is_admin: boolean | null };

const CACHE_MS = 60_000;
let cache: { leden: Lid[]; tot: number } | null = null;

/** Leden uit app_users. Rechtstreeks via REST: dit draait ook in de middleware (edge). */
async function leden(): Promise<Lid[]> {
  if (cache && cache.tot > Date.now()) return cache.leden;
  const url = optionalEnv('NEXT_PUBLIC_SUPABASE_URL');
  const sleutel = optionalEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !sleutel) return cache?.leden ?? [];
  try {
    const res = await fetch(`${url}/rest/v1/app_users?select=id,email,name,is_admin`, {
      headers: { apikey: sleutel, authorization: `Bearer ${sleutel}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return cache?.leden ?? [];
    const rijen = (await res.json()) as Lid[];
    cache = { leden: rijen, tot: Date.now() + CACHE_MS };
    return rijen;
  } catch {
    // Database even onbereikbaar: liever de vorige lijst dan iedereen buitensluiten.
    return cache?.leden ?? [];
  }
}

const uitEnv = (naam: string): string[] =>
  optionalEnv(naam)
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

/** De gebruiker bij dit (door Google bevestigde) adres, of null als het geen toegang heeft. */
export async function gebruikerVoor(email: string | null | undefined): Promise<Gebruiker | null> {
  const adres = email?.trim().toLowerCase();
  if (!adres) return null;
  const lid = (await leden()).find((l) => l.email?.trim().toLowerCase() === adres);
  if (!lid && !uitEnv('GOOGLE_TOEGANG_EMAILS').includes(adres)) return null;
  return {
    id: lid?.id ?? adres,
    email: adres,
    name: lid?.name || adres.split('@')[0],
    is_admin: Boolean(lid?.is_admin) || uitEnv('ADMIN_EMAIL').includes(adres),
  };
}
