import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { startCloudRun } from '@/lib/jobs';
import {
  afwerkDownloadUrl,
  effectieveStatus,
  leesAfwerkStatus,
  schrijfAfwerkStatus,
  type AfwerkStatus,
} from '@/lib/roughcut/afwerkstatus';

/**
 * "Afwerken in Premiere": het pakket (Premiere-project + 4K-bron + kaarten +
 * audio + ondertitels) voor één gerenderd bestand.
 *
 * Het bouwen zelf gebeurt niet hier: de 4K-secties zijn tientallen MB's per
 * stuk en een ontbrekende sectie ophalen vraagt yt-dlp en ffmpeg — dat past
 * niet in een serverless functie. Deze route zet de aanvraag in R2 en start
 * de workflow afwerkpakket.yml; die zet de zip in R2 en de status op 'klaar'.
 *
 * GET  ?bestand=<naam>  → status (+ downloadlink als hij klaar is)
 * POST {bestand_naam, opnieuw?} → aanvragen (of de bestaande teruggeven)
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const bestand = req.nextUrl.searchParams.get('bestand');
  if (!bestand) return NextResponse.json({ error: 'bestand is verplicht' }, { status: 400 });
  const s = await leesAfwerkStatus(params.id, bestand);
  if (!s) return NextResponse.json({ status: null });
  return NextResponse.json(await antwoord(s));
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as { bestand_naam?: string; opnieuw?: boolean };
  if (!body.bestand_naam) return NextResponse.json({ error: 'bestand_naam is verplicht' }, { status: 400 });

  const { data: job } = await db().from('render_jobs').select('id, status, bestanden').eq('id', params.id).single();
  if (!job) return NextResponse.json({ error: 'Render niet gevonden' }, { status: 404 });
  if (job.status !== 'klaar') return NextResponse.json({ error: 'Deze render is nog niet klaar' }, { status: 409 });
  const bekend = ((job.bestanden ?? []) as { naam: string }[]).some((b) => b.naam === body.bestand_naam);
  if (!bekend) return NextResponse.json({ error: 'Dit bestand hoort niet bij deze render' }, { status: 404 });

  // Loopt er al een, of is hij klaar: die teruggeven in plaats van dubbel werk.
  const bestaand = await leesAfwerkStatus(params.id, body.bestand_naam);
  if (bestaand && !body.opnieuw) {
    const eff = effectieveStatus(bestaand);
    if (eff.status !== 'mislukt') return NextResponse.json(await antwoord(bestaand));
  }

  const nu = new Date().toISOString();
  const s: AfwerkStatus = {
    status: 'wachtend',
    render_job_id: params.id,
    bestand_naam: body.bestand_naam,
    aangevraagd_at: nu,
    bijgewerkt_at: nu,
    voortgang: 'in de wachtrij',
  };
  try {
    await schrijfAfwerkStatus(s);
  } catch (e) {
    return NextResponse.json({ error: `Aanvraag niet op te slaan: ${(e as Error).message}` }, { status: 500 });
  }
  const gestart = await startCloudRun('afwerkpakket.yml');
  return NextResponse.json({
    ...(await antwoord(s)),
    direct_gestart: gestart,
    melding: gestart
      ? 'Pakket wordt gemaakt in de cloud (een paar minuten).'
      : 'Aanvraag staat klaar, maar de cloud kon niet direct gestart worden (GH_DISPATCH_TOKEN?). Start de workflow "afwerkpakket" handmatig.',
  });
}

async function antwoord(ruw: AfwerkStatus) {
  const s = effectieveStatus(ruw);
  return {
    status: s.status,
    voortgang: s.voortgang ?? null,
    fout: s.fout ?? null,
    meldingen: s.meldingen ?? [],
    bytes: s.bytes ?? null,
    bijgewerkt_at: s.bijgewerkt_at,
    url: await afwerkDownloadUrl(s),
  };
}
