import { NextRequest, NextResponse } from 'next/server';
import { runPlannerForVideo } from '@/lib/planner/run';
import { SchemaValidationError } from '@/lib/claude';

// De pipeline doet twee grote Claude-calls; die passen niet in de standaard 10s.
export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}) as { reuse_character_map?: boolean });

  try {
    const result = await runPlannerForVideo(params.id, {
      reuseCharacterMap: body.reuse_character_map ?? false,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof SchemaValidationError) {
      return NextResponse.json({ error: e.message, raw: e.raw }, { status: 502 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
