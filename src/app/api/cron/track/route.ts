import { NextRequest, NextResponse } from 'next/server';
import { runTracking } from '@/lib/tracking/run';
import { optionalEnv } from '@/lib/env';

export const maxDuration = 300;

/** Cron elke 6 uur (sectie 9). Vercel Cron stuurt CRON_SECRET mee als Bearer-token. */
export async function GET(req: NextRequest) {
  const secret = optionalEnv('CRON_SECRET');
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runTracking();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
