import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

export async function GET() {
  const { data, error } = await db().from('campaigns').select('*').order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaigns: data });
}

/** Nieuwe campagne met regels, CPM en verboden content (workflow-stap 1). */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    name: string;
    cpm_eur?: number;
    budget_eur?: number;
    platform_rules?: Record<string, unknown>;
  };

  if (!body.name) return NextResponse.json({ error: 'name is verplicht' }, { status: 400 });

  const { data, error } = await db()
    .from('campaigns')
    .insert({
      name: body.name,
      cpm_eur: body.cpm_eur ?? 0.5,
      budget_eur: body.budget_eur ?? null,
      platform_rules: body.platform_rules ?? {},
      status: 'active',
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaign: data });
}
