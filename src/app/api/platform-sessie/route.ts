import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { beschrijfVerzoek, parseCurl } from '@/lib/curl';

/** Het verzoek waarmee campagnes opgehaald worden bewaren of wissen. */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { platform?: string; curl?: string };
  const platform = body.platform ?? 'cliparmy';

  if (!body.curl?.trim()) {
    await db().from('platform_sessies').delete().eq('platform', platform);
    return NextResponse.json({ ok: true, gewist: true });
  }

  let verzoek;
  try {
    verzoek = parseCurl(body.curl);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const { error } = await db()
    .from('platform_sessies')
    .upsert(
      { platform, verzoek, cookie: null, laatste_fout: null, laatste_check: null },
      { onConflict: 'platform' },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, verzoek: beschrijfVerzoek(verzoek) });
}
