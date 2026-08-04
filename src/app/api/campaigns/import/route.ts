import { NextRequest, NextResponse } from 'next/server';
import { SchemaValidationError } from '@/lib/claude';
import { importeerCampagneTekst } from '@/lib/campagne-import';

export const maxDuration = 120;

/**
 * Campagne-import: plak de tekst van een campagnepagina en er wordt een
 * campagne aangemaakt met geparste regels. Bewust een mens in de lus: de
 * controle op de regels blijft bij ons liggen.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { tekst?: string };
  if (!body.tekst?.trim() || body.tekst.trim().length < 40) {
    return NextResponse.json(
      { error: 'Plak de volledige campagnetekst (regels, CPM, verboden content).' },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await importeerCampagneTekst(body.tekst));
  } catch (e) {
    if (e instanceof SchemaValidationError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
