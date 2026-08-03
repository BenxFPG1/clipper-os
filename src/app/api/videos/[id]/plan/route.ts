import { NextRequest, NextResponse } from 'next/server';
import { runPlannerForVideo } from '@/lib/planner/run';
import { SchemaValidationError } from '@/lib/claude';
import { queueAiJob } from '@/lib/jobs';

// De pipeline doet twee grote Claude-calls; die passen niet in de standaard 10s.
export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as {
    reuse_character_map?: boolean;
    opnieuw_analyseren?: boolean;
  };
  // Hergebruik is de standaard; alleen als je expliciet opnieuw wilt
  // analyseren draaien we die dure call nog eens.
  const opnieuwAnalyseren = body.opnieuw_analyseren ?? body.reuse_character_map === false;

  try {
    const result = await runPlannerForVideo(params.id, { opnieuwAnalyseren });
    return NextResponse.json(result);
  } catch (e) {
    const bericht = e instanceof Error ? e.message : String(e);
    // Zonder Claude-backend (live site) gaat het plan naar de cloudwachtrij.
    const geenClaude = /Ontbrekende env var|CLI niet gevonden|niet \(meer\) ingelogd|ENOENT/i.test(bericht);
    if (geenClaude) {
      const { jobId, directGestart } = await queueAiJob('clip_plan', params.id, {
        opnieuw_analyseren: opnieuwAnalyseren,
      });
      return NextResponse.json({
        inWachtrij: true,
        jobId,
        directGestart,
        melding: directGestart
          ? 'Het clip-plan wordt nu in de cloud gemaakt; dit duurt een paar minuten.'
          : 'Het clip-plan staat in de wachtrij voor de volgende cloudrun.',
      });
    }
    if (e instanceof SchemaValidationError) {
      return NextResponse.json({ error: bericht, raw: e.raw }, { status: 502 });
    }
    return NextResponse.json({ error: bericht }, { status: 500 });
  }
}
