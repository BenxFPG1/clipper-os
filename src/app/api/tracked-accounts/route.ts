import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

export async function GET() {
  const { data, error } = await db().from('tracked_accounts').select('*').order('handle');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ accounts: data });
}

/** Voegt een account toe om te volgen: een concurrent-clipper of de creator zelf. */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    handle: string;
    platform: 'tiktok' | 'reels' | 'shorts';
    our_own?: boolean;
  };

  if (!body.handle?.trim() || !body.platform) {
    return NextResponse.json({ error: 'handle en platform zijn verplicht' }, { status: 400 });
  }

  const { data, error } = await db()
    .from('tracked_accounts')
    .upsert(
      { handle: body.handle.trim().replace(/^@/, ''), platform: body.platform, our_own: body.our_own ?? false },
      { onConflict: 'handle,platform' },
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ account: data });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is verplicht' }, { status: 400 });

  const { error } = await db().from('tracked_accounts').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
