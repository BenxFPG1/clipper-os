import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

export async function GET() {
  const { data, error } = await db().from('themes').select('*').order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ themes: data });
}

/** Thema toevoegen of bijwerken: bepaalt waar de scout op zoekt én hoe kennis wordt opgesplitst. */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    slug: string;
    name: string;
    description?: string;
    zoektermen?: string[];
    actief?: boolean;
  };

  const slug = body.slug?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!slug || !body.name?.trim()) {
    return NextResponse.json({ error: 'slug en naam zijn verplicht' }, { status: 400 });
  }

  const { data, error } = await db()
    .from('themes')
    .upsert(
      {
        slug,
        name: body.name.trim(),
        description: body.description?.trim() || null,
        zoektermen: (body.zoektermen ?? []).map((z) => z.trim()).filter(Boolean),
        actief: body.actief ?? true,
      },
      { onConflict: 'slug' },
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ theme: data });
}

export async function DELETE(req: NextRequest) {
  const slug = new URL(req.url).searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug is verplicht' }, { status: 400 });

  const { error } = await db().from('themes').delete().eq('slug', slug);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
