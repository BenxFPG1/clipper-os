import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

/** Sessiecookie voor het automatisch ophalen van campagnes bewaren of wissen. */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { platform?: string; cookie?: string };
  const platform = body.platform ?? 'cliparmy';

  if (!body.cookie?.trim()) {
    await db().from('platform_sessies').delete().eq('platform', platform);
    return NextResponse.json({ ok: true, gewist: true });
  }

  const { error } = await db()
    .from('platform_sessies')
    .upsert(
      { platform, cookie: body.cookie.trim(), laatste_fout: null, laatste_check: null },
      { onConflict: 'platform' },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
