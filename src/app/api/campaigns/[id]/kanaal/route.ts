import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { startCloudRun } from '@/lib/jobs';
import { haalNieuweBronvideos } from '@/lib/ingest/kanaal';

export const maxDuration = 300;

/** Bronkanaal en auto-plan instellen voor deze campagne. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json()) as {
    bron_kanalen?: string[];
    bron_kanaal_url?: string | null;
    auto_plan?: boolean;
  };

  const update: Record<string, unknown> = {};
  if (Array.isArray(body.bron_kanalen)) {
    const schoon = [...new Set(body.bron_kanalen.map((k) => String(k).trim()).filter(Boolean))];
    update.bron_kanalen = schoon;
    // De losse kolom leegmaken zodat de lijst de enige waarheid is.
    update.bron_kanaal_url = null;
  }
  if ('bron_kanaal_url' in body && !Array.isArray(body.bron_kanalen)) {
    update.bron_kanaal_url = body.bron_kanaal_url || null;
  }
  if (typeof body.auto_plan === 'boolean') update.auto_plan = body.auto_plan;

  const { error } = await db().from('campaigns').update(update).eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/**
 * Nu meteen nieuwe uploads ophalen. Lokaal kan dat direct (yt-dlp aanwezig);
 * op de live site is er geen yt-dlp, dus starten we de cloudrun die het doet.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const r = await haalNieuweBronvideos();
    const vanCampagne = r.toegevoegd.length;

    // Op de live site bestaat yt-dlp niet. Die fout wordt per bron opgevangen,
    // dus we kwamen hier met "0 opgehaald, 4 problemen" in plaats van uit te
    // wijken naar de cloud. Zien we alleen dat soort fouten, dan is dit geen
    // inhoudelijk probleem maar een omgeving zonder de juiste tools.
    const alleenGeenTools =
      vanCampagne === 0 &&
      r.fouten.length > 0 &&
      r.fouten.every((f) => /yt-dlp|ENOENT|spawn|not found|niet gevonden/i.test(f));
    if (alleenGeenTools) {
      const gestart = await startCloudRun('ai-jobs.yml');
      // Optimistisch: de klik zélf is het startmoment. De worker overschrijft
      // dit zodra hij deze campagne daadwerkelijk oppakt (dat kan een minuut
      // of twee duren door de installatiestappen van de workflow), en wist
      // het weer zodra hij klaar is. Zonder dit zag je na de klik niets meer
      // gebeuren totdat de nieuwe video's er ineens waren.
      if (gestart) {
        await db().from('campaigns').update({ kanaal_check_gestart_at: new Date().toISOString() }).eq('id', params.id);
      }
      return NextResponse.json({
        inWachtrij: true,
        melding: gestart
          ? 'Ophalen gestart in de cloud (de site kan zelf geen video downloaden); over een paar minuten staan ze hier.'
          : 'Ophalen staat klaar voor de volgende cloudrun.',
      });
    }

    return NextResponse.json({
      melding:
        vanCampagne > 0
          ? `${vanCampagne} nieuwe video('s) opgehaald.` + (r.fouten.length ? ` ${r.fouten.length} probleem(en) — zie hieronder.` : '')
          : 'Geen nieuwe uploads gevonden.' + (r.fouten.length ? ` ${r.fouten.length} probleem(en) — zie hieronder.` : ''),
      toegevoegd: r.toegevoegd,
      fouten: r.fouten,
    });
  } catch (e) {
    const bericht = e instanceof Error ? e.message : String(e);
    const geenTools = /yt-dlp|ENOENT|niet gevonden|spawn/i.test(bericht);
    if (geenTools) {
      const gestart = await startCloudRun('ai-jobs.yml');
      if (gestart) {
        await db().from('campaigns').update({ kanaal_check_gestart_at: new Date().toISOString() }).eq('id', params.id);
      }
      return NextResponse.json({
        melding: gestart
          ? 'Ophalen gestart in de cloud; nieuwe videos staan er over een paar minuten.'
          : 'Ophalen staat klaar voor de volgende cloudrun.',
        inWachtrij: true,
      });
    }
    void params;
    return NextResponse.json({ error: bericht }, { status: 500 });
  }
}
