import { NextResponse } from 'next/server';
import { runEvalAgent } from '@/lib/agents/eval';

export const maxDuration = 300;

/** Draait alle eval-cases. Status 409 als er een case faalt: de wijziging mag niet live. */
export async function POST() {
  try {
    const result = await runEvalAgent();
    return NextResponse.json(result, { status: result.passed ? 200 : 409 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
