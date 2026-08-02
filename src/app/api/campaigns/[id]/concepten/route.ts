import { NextRequest, NextResponse } from 'next/server';
import { SchemaValidationError } from '@/lib/claude';
import { bedenkConcepten } from '@/lib/concepten';
import { queueAiJob } from '@/lib/jobs';

export const maxDuration = 300;

/**
 * Bedenkt automatisch opdrachten voor deze campagne. Kan de omgeving zelf
 * denken (lokaal met de Claude-CLI), dan gebeurt het direct; op de live site
 * gaat het naar de wachtrij en pakt GitHub Actions het op.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as { aantal?: number };
  const aantal = body.aantal ?? 8;

  try {
    const rijen = await bedenkConcepten(params.id, aantal);
    return NextResponse.json({ briefs: rijen });
  } catch (e) {
    const bericht = e instanceof Error ? e.message : String(e);
    const geenClaude = /Ontbrekende env var|CLI niet gevonden|niet \(meer\) ingelogd|ENOENT/i.test(bericht);
    if (geenClaude) {
      const { jobId, directGestart } = await queueAiJob('concepten', params.id, { aantal });
      return NextResponse.json({
        inWachtrij: true,
        jobId,
        directGestart,
        melding: directGestart
          ? 'Concepten worden nu in de cloud bedacht; over een paar minuten staan ze hier.'
          : 'Concepten staan in de wachtrij; de volgende cloudrun pakt ze op.',
      });
    }
    if (e instanceof SchemaValidationError) {
      return NextResponse.json({ error: bericht }, { status: 502 });
    }
    return NextResponse.json({ error: bericht }, { status: 500 });
  }
}
