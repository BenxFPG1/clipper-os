import { NextRequest, NextResponse } from 'next/server';
import { applyRetroProposal, rejectRetroProposal } from '@/lib/agents/retro';

/** Antonie keurt een vault-voorstel goed of af (sectie 3, principe 4). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json()) as { decision: 'approve' | 'reject'; decided_by?: string };
  const decidedBy = body.decided_by ?? 'antonie';

  try {
    if (body.decision === 'approve') {
      const result = await applyRetroProposal(params.id, decidedBy);
      return NextResponse.json({ status: 'approved', ...result });
    }
    if (body.decision === 'reject') {
      await rejectRetroProposal(params.id, decidedBy);
      return NextResponse.json({ status: 'rejected' });
    }
    return NextResponse.json({ error: 'decision moet approve of reject zijn' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
