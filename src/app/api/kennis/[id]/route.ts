import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { AFGEWEZEN, WACHT_OP_AKKOORD } from '@/lib/vault/kennis';

/**
 * Een les goedkeuren (hij gaat de prompt in), afwijzen of uitzetten.
 * Body: { besluit: 'aan' | 'uit' }.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as { besluit?: string };
  if (body.besluit !== 'aan' && body.besluit !== 'uit') {
    return NextResponse.json({ error: "besluit moet 'aan' of 'uit' zijn" }, { status: 400 });
  }
  const supabase = db();
  const { data: rij, error } = await supabase.from('vault_kennis').select('bron').eq('id', params.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rij) return NextResponse.json({ error: 'Les niet gevonden' }, { status: 404 });

  const kaal = String(rij.bron ?? '').replace(WACHT_OP_AKKOORD, '').replace(AFGEWEZEN, '').trim();
  const update =
    body.besluit === 'aan'
      ? { actief: true, bron: kaal || null }
      : { actief: false, bron: `${kaal} ${AFGEWEZEN}`.trim() };
  const { error: fout } = await supabase.from('vault_kennis').update(update).eq('id', params.id);
  if (fout) return NextResponse.json({ error: fout.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
