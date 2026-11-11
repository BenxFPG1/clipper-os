import { NextRequest, NextResponse } from 'next/server';

/** Wie is er ingelogd? De middleware heeft dat al vastgesteld en op het verzoek gezet. */
export async function GET(request: NextRequest) {
  const email = request.headers.get('x-user-email');
  if (!email) return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 });
  return NextResponse.json({
    id: request.headers.get('x-user-id'),
    email,
    name: request.headers.get('x-user-name'),
    is_admin: request.headers.get('x-is-admin') === 'true',
  });
}
