import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { rejectRetroProposal } from '@/lib/agents/retro';

/**
 * Wijst alle openstaande retro-voorstellen af behalve de nieuwste. Elk
 * voorstel rekent met de data van zijn eigen week; het nieuwste heeft alles
 * wat de oudere zagen plus meer, dus die zijn achterhaald. Een UI-hulp: de
 * gebruiker drukt zelf op de knop (met bevestiging), niets gebeurt vanzelf.
 */
export async function POST(req: NextRequest) {
  const decidedBy = `${req.headers.get('x-user-email') ?? 'onbekend'} (verouderd)`;
  const { data, error } = await db()
    .from('agent_runs')
    .select('id, created_at')
    .eq('agent', 'retro')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ouder = (data ?? []).slice(1);
  try {
    for (const run of ouder) await rejectRetroProposal(run.id as string, decidedBy);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return NextResponse.json({ afgewezen: ouder.length, bewaard: data?.[0]?.id ?? null });
}
