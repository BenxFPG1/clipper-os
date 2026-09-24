import { NextResponse } from 'next/server';
import { runScoutAgent } from '@/lib/agents/scout';

export const maxDuration = 300;

/**
 * "Scout nu draaien" vanuit de UI. Bewust los van /api/cron/scout: die route
 * eist het Bearer-token van de cron (CRON_SECRET), dat de browser niet heeft
 * en ook niet hoort te hebben. Hier volstaat de ingelogde sessie, die de
 * middleware al afdwingt.
 */
export async function POST() {
  try {
    const result = await runScoutAgent();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
