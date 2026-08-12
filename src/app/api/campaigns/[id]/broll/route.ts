import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { startCloudRun } from '@/lib/jobs';

/**
 * B-roll-campagne: Drive-link opslaan en de ingest + editplan in de cloud
 * starten. De site zelf kan geen video's downloaden of analyseren (geen
 * ffmpeg/gdown op serverless), dus dit is altijd een cloudopdracht — zelfde
 * model als de kanaalcheck en de renders.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as { drive_url?: string };
  const driveUrl = body.drive_url?.trim();
  if (!driveUrl || !/drive\.google\.com/.test(driveUrl)) {
    return NextResponse.json({ error: 'Geen geldige Google Drive-link.' }, { status: 400 });
  }

  const supabase = db();
  await supabase.from('campaigns').update({ bron_drive_url: driveUrl }).eq('id', params.id);

  // Zelfde opdracht al in de rij? Niet dubbel aanmaken.
  const { data: bestaand } = await supabase
    .from('ai_jobs')
    .select('id')
    .eq('soort', 'broll_ingest')
    .eq('doel_id', params.id)
    .in('status', ['wachtend', 'bezig'])
    .limit(1)
    .maybeSingle();

  let jobId = bestaand?.id as string | undefined;
  if (!jobId) {
    const { data, error } = await supabase
      .from('ai_jobs')
      .insert({ soort: 'broll_ingest', doel_id: params.id, parameters: { drive_url: driveUrl } })
      .select('id')
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    jobId = data.id as string;
  }

  const gestart = await startCloudRun('ai-jobs.yml');
  return NextResponse.json({
    jobId,
    melding: gestart
      ? 'B-roll ophalen en editplan maken gestart in de cloud; afhankelijk van de hoeveelheid beelden duurt dit 10-30 minuten.'
      : 'B-roll-opdracht staat klaar voor de volgende cloudrun.',
  });
}
