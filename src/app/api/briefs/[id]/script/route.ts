import { NextResponse } from 'next/server';
import { runScriptwriterForBrief } from '@/lib/scriptwriter';
import { SchemaValidationError } from '@/lib/claude';
import { queueAiJob } from '@/lib/jobs';

export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as { aantal?: number };
  const aantal = body.aantal ?? 1;

  try {
    const result = await runScriptwriterForBrief(params.id, aantal);
    return NextResponse.json(result);
  } catch (e) {
    const bericht = e instanceof Error ? e.message : String(e);
    // Zonder Claude-backend (live site) gaat het werk naar de cloudwachtrij.
    const geenClaude = /Ontbrekende env var|CLI niet gevonden|niet \(meer\) ingelogd|ENOENT/i.test(bericht);
    if (geenClaude) {
      const { jobId, directGestart } = await queueAiJob('scripts', params.id, { aantal });
      return NextResponse.json({
        inWachtrij: true,
        jobId,
        directGestart,
        melding: directGestart
          ? `${aantal} verhaallijn(en) worden nu in de cloud geschreven.`
          : `${aantal} verhaallijn(en) staan in de wachtrij voor de volgende cloudrun.`,
      });
    }
    if (e instanceof SchemaValidationError) {
      return NextResponse.json({ error: bericht, raw: e.raw }, { status: 502 });
    }
    return NextResponse.json({ error: bericht }, { status: 500 });
  }
}
