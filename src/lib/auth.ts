import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

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
  const sessionId = randomUUID();
  
  await supabase
    .from('sessions')
    .insert({
      id: sessionId,
      user_id: userId,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    });
  
  return sessionId;
}

// Haal gebruiker op via session ID
export async function getUserFromSession(sessionId: string): Promise<UserPayload | null> {
  if (!sessionId) return null;

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
  await supabase
    .from('sessions')
    .delete()
    .eq('id', sessionId);
}