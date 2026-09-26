import { NextRequest, NextResponse } from 'next/server';
import { zetEvalRendersKlaar } from '@/lib/tracking/leerlus';

/**
 * Optionele smaak-eval, stap 1: zet voor elke render in de eval-set een
 * nieuwe render klaar met de huidige code. De vergelijking (stap 2) draai je
 * zelf met `npm run eval:smaak -- --uitslag` zodra die renders klaar zijn.
 * Niets hangt hiervan af en niets start dit vanzelf.
 */
export async function POST(req: NextRequest) {
  try {
    const r = await zetEvalRendersKlaar({ door: req.headers.get('x-user-email') });
    if (r.paren.length === 0) {
      return NextResponse.json({ error: 'Er staan nog geen renders in de eval-set.' }, { status: 400 });
    }
    return NextResponse.json({
      run_id: r.runId,
      paren: r.paren.length,
      nieuwe_renders: r.nieuweJobs,
      melding: `${r.nieuweJobs} nieuwe render(s) klaargezet voor ${r.paren.length} eval-case(s). Zodra ze klaar zijn: npm run eval:smaak -- --uitslag`,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
