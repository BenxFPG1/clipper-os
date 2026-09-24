import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export interface UserPayload {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
}

// Maak een nieuwe sessie aan
export async function createSession(userId: string): Promise<string> {
  // Web Crypto in plaats van node:crypto: dit bestand wordt ook door de
  // middleware (Edge Runtime) geladen, en die kent de Node-module niet.
  const sessionId = globalThis.crypto.randomUUID();
  
  await supabase
    .from('sessions')
    .insert({
      id: sessionId,
      user_id: userId,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    });
  
  return sessionId;
}

/**
 * Korte cache op sessie → gebruiker. De middleware draait op elk verzoek,
 * ook op de prefetches van <Link>; zonder cache is dat per navigatie een
 * extra rondje naar Supabase. Dertig seconden is kort genoeg dat een
 * admin-wijziging niet lang blijft hangen; bij uitloggen verdwijnt de cookie,
 * dus die sessie-id komt hier sowieso niet meer langs. (De middleware draait
 * op de edge in een eigen module-instantie: deze cache is per instantie.)
 */
const SESSIE_CACHE_MS = 30_000;
const sessieCache = new Map<string, { user: UserPayload | null; tot: number }>();

// Haal gebruiker op via session ID
export async function getUserFromSession(sessionId: string): Promise<UserPayload | null> {
  if (!sessionId) return null;

  const gecached = sessieCache.get(sessionId);
  if (gecached && gecached.tot > Date.now()) return gecached.user;

  const user = await laadUserVanSessie(sessionId);
  sessieCache.set(sessionId, { user, tot: Date.now() + SESSIE_CACHE_MS });
  // Niet eindeloos laten groeien: een verlopen entry ruimt zichzelf op.
  if (sessieCache.size > 500) {
    for (const [id, entry] of sessieCache) if (entry.tot <= Date.now()) sessieCache.delete(id);
  }
  return user;
}

async function laadUserVanSessie(sessionId: string): Promise<UserPayload | null> {

  const { data, error } = await supabase
    .from('sessions')
    .select(`
      user_id,
      app_users:user_id (
        id,
        email,
        name,
        is_admin
      )
    `)
    .eq('id', sessionId)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (error || !data) {
    console.log('Sessie niet gevonden of verlopen:', error);
    return null;
  }

  // Fix: data.app_users kan een array zijn of een object
  const userData = Array.isArray(data.app_users) ? data.app_users[0] : data.app_users;
  
  if (!userData) {
    console.log('Geen gebruiker gevonden voor sessie');
    return null;
  }

  return {
    id: userData.id,
    email: userData.email,
    name: userData.name || userData.email.split('@')[0],
    is_admin: userData.is_admin
  };
}

// Haal gebruiker uit cookies (voor middleware)
export async function getUserFromCookies(request: NextRequest): Promise<UserPayload | null> {
  const sessionId = request.cookies.get('session')?.value;
  if (!sessionId) return null;
  return await getUserFromSession(sessionId);
}

// Haal gebruiker uit request (voor API routes)
export async function getUserFromRequest(request: Request): Promise<UserPayload | null> {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  
  const cookies = Object.fromEntries(
    cookieHeader.split('; ').map(c => {
      const [key, ...value] = c.split('=');
      return [key, value.join('=')];
    })
  );
  
  const sessionId = cookies.session;
  if (!sessionId) return null;
  
  return await getUserFromSession(sessionId);
}

// Verwijder sessie (uitloggen)
export async function deleteSession(sessionId: string): Promise<void> {
  sessieCache.delete(sessionId);
  await supabase
    .from('sessions')
    .delete()
    .eq('id', sessionId);
}