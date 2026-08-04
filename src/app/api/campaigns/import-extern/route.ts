import { NextRequest, NextResponse } from 'next/server';
import { SchemaValidationError } from '@/lib/claude';
import { importeerCampagneTekst } from '@/lib/campagne-import';

export const maxDuration = 120;

const CORS = {
  'Access-Control-Allow-Origin': 'https://cliparmy.nl',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-clipper-sleutel',
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * Import vanaf de bookmarklet: je staat ingelogd op cliparmy.nl, klikt de
 * bladwijzer, en de campagnetekst van de pagina komt hier binnen. Bewust géén
 * geautomatiseerde login of scraper op hun platform — jij bezoekt de pagina
 * zelf, de tool vangt alleen wat jij al ziet.
 */
export async function POST(req: NextRequest) {
  const sleutel = req.headers.get('x-clipper-sleutel');
  if (!process.env.APP_PASSWORD || sleutel !== process.env.APP_PASSWORD) {
    return NextResponse.json({ error: 'Ongeldige sleutel' }, { status: 401, headers: CORS });
  }

  const body = (await req.json().catch(() => ({}))) as { tekst?: string };
  if (!body.tekst?.trim() || body.tekst.trim().length < 40) {
    return NextResponse.json(
      { error: 'Geen campagnetekst gevonden op de pagina.' },
      { status: 400, headers: CORS },
    );
  }

  try {
    const r = await importeerCampagneTekst(body.tekst);
    return NextResponse.json(r, { headers: CORS });
  } catch (e) {
    if (e instanceof SchemaValidationError) {
      return NextResponse.json({ error: e.message }, { status: 502, headers: CORS });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: CORS },
    );
  }
}
