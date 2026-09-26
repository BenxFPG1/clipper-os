import { NextRequest, NextResponse } from 'next/server';
import { bewaarBeoordeling, LeerlusFout, OORDELEN, type Oordeel } from '@/lib/tracking/leerlus';

/**
 * Oordeel over één gerenderd bestand: goed / matig / weg, optioneel met één
 * zin waarom en een vinkje "in eval-set". Upsert: nog eens klikken
 * overschrijft het vorige oordeel. Wie het gaf komt uit de header die de
 * middleware zet (een meegestuurde waarde wordt daar overschreven).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as {
    bestand_naam?: string;
    oordeel?: string;
    reden?: string | null;
    eval_case?: boolean;
  };
  if (!body.bestand_naam) return NextResponse.json({ error: 'bestand_naam is verplicht' }, { status: 400 });
  if (body.oordeel !== undefined && !OORDELEN.includes(body.oordeel as Oordeel)) {
    return NextResponse.json({ error: `Ongeldig oordeel; kies uit ${OORDELEN.join(', ')}.` }, { status: 400 });
  }
  if (body.eval_case !== undefined && typeof body.eval_case !== 'boolean') {
    return NextResponse.json({ error: 'eval_case moet true of false zijn' }, { status: 400 });
  }

  try {
    const beoordeling = await bewaarBeoordeling({
      renderJobId: params.id,
      bestandNaam: body.bestand_naam,
      oordeel: body.oordeel as Oordeel | undefined,
      reden: body.reden,
      evalCase: body.eval_case,
      door: req.headers.get('x-user-email'),
    });
    return NextResponse.json({ beoordeling });
  } catch (e) {
    const status = e instanceof LeerlusFout ? e.status : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
