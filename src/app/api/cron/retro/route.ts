import { NextRequest, NextResponse } from 'next/server';
import { runRetroAgent } from '@/lib/agents/retro';
import { optionalEnv } from '@/lib/env';

export const maxDuration = 300;

/** Wekelijkse retro (zondag, sectie 10). Zet een voorstel klaar; muteert niets. */
export async function GET(req: NextRequest) {
  const secret = optionalEnv('CRON_SECRET');
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runRetroAgent();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
