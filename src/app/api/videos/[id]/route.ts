import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

/**
 * Archiveren in plaats van verwijderen: de video (met transcript, plannen en
 * geschiedenis) blijft bestaan voor de vault en de retro, maar verdwijnt uit
 * de werklijst. Terugzetten kan altijd.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json()) as { gearchiveerd?: boolean };
  if (typeof body.gearchiveerd !== 'boolean') {
    return NextResponse.json({ error: 'Geef "gearchiveerd": true of false mee.' }, { status: 400 });
  }

  const { error } = await db()
    .from('videos')
    .update({ archived_at: body.gearchiveerd ? new Date().toISOString() : null })
    .eq('id', params.id);

  if (error) {
    const hint = error.message.includes('archived_at')
      ? ' (draai in de Supabase SQL-editor: alter table videos add column if not exists archived_at timestamptz;)'
      : '';
    return NextResponse.json({ error: error.message + hint }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
