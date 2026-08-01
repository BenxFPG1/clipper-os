import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

/**
 * Feedback op een scriptversie. Wordt bewaard bij die versie en gaat integraal
 * mee in elke volgende generatie voor deze opdracht — zo leert de scriptwriter
 * van menselijke correcties in plaats van dezelfde fout te herhalen.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { scriptId, feedback } = (await req.json()) as { scriptId?: string; feedback?: string };
  if (!scriptId || !feedback?.trim()) {
    return NextResponse.json({ error: 'scriptId en feedback zijn verplicht' }, { status: 400 });
  }

  const { error } = await db()
    .from('brief_scripts')
    .update({ feedback: feedback.trim() })
    .eq('id', scriptId)
    .eq('brief_id', params.id);

  if (error) {
    const hint = error.message.includes('feedback')
      ? ' (draai in de Supabase SQL-editor: alter table brief_scripts add column if not exists feedback text;)'
      : '';
    return NextResponse.json({ error: error.message + hint }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
