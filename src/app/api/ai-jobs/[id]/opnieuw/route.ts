import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { startCloudRun } from '@/lib/jobs';

/**
 * "Opnieuw proberen" vanaf het dashboard: de opdracht terug in de wachtrij,
 * met een schone herkansingsteller (dus weer twee automatische herkansingen)
 * en zonder wachttijd, en meteen een cloudrun erachteraan.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = db();
  const { data: job, error } = await supabase.from('ai_jobs').select('id, status, parameters').eq('id', params.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!job) return NextResponse.json({ error: 'Opdracht niet gevonden.' }, { status: 404 });
  if (job.status === 'bezig') return NextResponse.json({ melding: 'Deze opdracht loopt al.' });

  const { herkansing: _h, volgende_poging_na: _v, ...rest } = (job.parameters ?? {}) as Record<string, unknown>;
  void _h;
  void _v;
  const { error: updateFout } = await supabase
    .from('ai_jobs')
    .update({ status: 'wachtend', fout: null, gestart_at: null, klaar_at: null, parameters: rest })
    .eq('id', params.id);
  if (updateFout) return NextResponse.json({ error: updateFout.message }, { status: 500 });

  const gestart = await startCloudRun('ai-jobs.yml');
  return NextResponse.json({
    melding: gestart ? 'Opnieuw gestart in de cloud.' : 'Terug in de wachtrij; de volgende cloudrun (binnen het uur) pakt hem op.',
  });
}
