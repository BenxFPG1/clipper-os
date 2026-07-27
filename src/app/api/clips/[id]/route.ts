import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { detectPlatform } from '@/lib/tracking/provider';

/**
 * Werkt één clip bij: status, post-URL, platform. Zodra er een post-URL binnenkomt
 * zetten we de clip op 'posted' met een posted_at, want dat is het startpunt voor
 * alle tijdvensters in de tracking.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json()) as {
    status?: 'planned' | 'edited' | 'posted' | 'rejected';
    post_url?: string;
    platform?: 'tiktok' | 'reels' | 'shorts';
    posted_at?: string;
  };

  const update: Record<string, unknown> = {};
  if (body.status) update.status = body.status;
  if (body.platform) update.platform = body.platform;

  if (body.post_url !== undefined) {
    update.post_url = body.post_url || null;
    if (body.post_url) {
      update.platform = body.platform ?? detectPlatform(body.post_url) ?? null;
      update.status = body.status ?? 'posted';
      update.posted_at = body.posted_at ?? new Date().toISOString();
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Niets om bij te werken' }, { status: 400 });
  }

  const { data, error } = await db().from('clips').update(update).eq('id', params.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clip: data });
}
