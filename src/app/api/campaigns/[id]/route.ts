import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

/** Campagne bijwerken: naam, status of CPM. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json()) as { name?: string; status?: string; cpm_eur?: number };

  const update: Record<string, unknown> = {};
  if (typeof body.name === 'string' && body.name.trim()) update.name = body.name.trim().slice(0, 120);
  if (body.status && ['active', 'paused', 'ended'].includes(body.status)) update.status = body.status;
  if (typeof body.cpm_eur === 'number' && body.cpm_eur >= 0) update.cpm_eur = body.cpm_eur;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Niets om bij te werken.' }, { status: 400 });
  }

  const { data, error } = await db().from('campaigns').update(update).eq('id', params.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaign: data });
}
