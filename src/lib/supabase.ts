import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from './env';

let cached: SupabaseClient | null = null;

/**
 * Service-role client. Alleen server-side gebruiken: Clipper OS is een interne
 * tool zonder auth, dus er is geen browser-client met anon key.
 */
export function db(): SupabaseClient {
  if (!cached) {
    cached = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    });
  }
  return cached;
}

/**
 * Supabase typeert een embedded relatie altijd als array, ook bij een 1-op-1
 * relatie zoals clips → clip_performance. Deze helper pakt er het enkele record
 * uit zodat de call-sites geen casts nodig hebben.
 */
export function one<T>(relation: T | T[] | null | undefined): T | null {
  if (Array.isArray(relation)) return relation[0] ?? null;
  return relation ?? null;
}

export async function logProviderUsage(provider: string, operation: string, units: number, costEur: number) {
  await db().from('provider_usage').insert({ provider, operation, units, cost_eur: costEur });
}
