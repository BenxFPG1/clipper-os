import { NextRequest, NextResponse } from 'next/server';
import { runScoutAgent } from '@/lib/agents/scout';
import { optionalEnv } from '@/lib/env';

export const maxDuration = 300;

/** Dagelijkse scout-run: kijkt bij andere accounts wat daar goed werkt. */
export async function GET(req: NextRequest) {
  const secret = optionalEnv('CRON_SECRET');
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runScoutAgent();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
