import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

export async function GET() {
  const { data, error } = await db().from('search_queries').select('*').order('created_at');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ queries: data });
}

/** Zoekterm toevoegen waarmee de scout zelf op de platforms zoekt. */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { query: string; platform: 'tiktok' | 'reels' | 'shorts' };

  if (!body.query?.trim() || !body.platform) {
    return NextResponse.json({ error: 'query en platform zijn verplicht' }, { status: 400 });
  }

  const { data, error } = await db()
    .from('search_queries')
    .upsert(
      { query: body.query.trim(), platform: body.platform, actief: true },
      { onConflict: 'query,platform' },
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ query: data });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is verplicht' }, { status: 400 });

  const { error } = await db().from('search_queries').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
