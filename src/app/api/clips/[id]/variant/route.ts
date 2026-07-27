import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

/**
 * Maakt een variant-clip aan die naar de originele clip wijst. De variant krijgt
 * een eigen rij zodat hij los getrackt en vergeleken kan worden — dat is precies
 * wat de Retro-agent nodig heeft om hooks tegen elkaar af te zetten.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json()) as { hook_text?: string; titel_intern?: string };
  const supabase = db();

  const { data: parent, error } = await supabase.from('clips').select('*').eq('id', params.id).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });

  const { data, error: insertError } = await supabase
    .from('clips')
    .insert({
      clip_plan_id: parent.clip_plan_id,
      plan_index: parent.plan_index,
      titel_intern: body.titel_intern ?? `${parent.titel_intern} (variant)`,
      structure_type: parent.structure_type,
      hook_type: parent.hook_type,
      hook_text: body.hook_text ?? parent.hook_text,
      status: 'planned',
      variant_of: parent.id,
    })
    .select()
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
  return NextResponse.json({ clip: data });
}
