import { NextResponse } from 'next/server';
import { runScriptwriterForBrief } from '@/lib/scriptwriter';
import { SchemaValidationError } from '@/lib/claude';

export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = (await req.json().catch(() => ({}))) as { aantal?: number };
    const result = await runScriptwriterForBrief(params.id, body.aantal ?? 1);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof SchemaValidationError) {
      return NextResponse.json({ error: e.message, raw: e.raw }, { status: 502 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
