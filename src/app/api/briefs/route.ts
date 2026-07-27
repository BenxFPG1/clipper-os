import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

export async function GET() {
  const { data, error } = await db()
    .from('briefs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ briefs: data });
}

/** Nieuwe opdracht: een briefing waar de tool een script bij schrijft. */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    titel: string;
    briefing: string;
    doel?: string;
    platform?: 'tiktok' | 'reels' | 'shorts';
    duur_seconden?: number;
    campaign_id?: string;
  };

  if (!body.titel?.trim() || !body.briefing?.trim()) {
    return NextResponse.json({ error: 'titel en briefing zijn verplicht' }, { status: 400 });
  }

  const { data, error } = await db()
    .from('briefs')
    .insert({
      titel: body.titel.trim(),
      briefing: body.briefing.trim(),
      doel: body.doel ?? null,
      platform: body.platform ?? null,
      duur_seconden: body.duur_seconden ?? null,
      campaign_id: body.campaign_id ?? null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ brief: data });
}
