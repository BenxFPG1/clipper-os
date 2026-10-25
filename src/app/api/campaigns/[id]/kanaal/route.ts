import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { startCloudRun } from '@/lib/jobs';
import { haalNieuweBronvideos } from '@/lib/ingest/kanaal';
import { herkenBron } from '@/lib/ingest/bron-url';

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
    // Directe validatie: een link die we niet kunnen ophalen hoort niet
    // stilletjes in de lijst te belanden en pas morgen als fout te verschijnen.
    const onbekend = schoon.map((k) => ({ k, b: herkenBron(k) })).filter((x) => x.b.soort === 'onbekend');
    if (onbekend.length) {
      return NextResponse.json(
        { error: onbekend.map((x) => `${x.k}: ${(x.b as { reden: string }).reden}`).join(' ') },
        { status: 400 },
      );
    }
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
 * Nu meteen nieuwe video's ophalen voor déze campagne. Lokaal kan dat direct
 * (yt-dlp, gdown en ffmpeg aanwezig); op de live site niet — daar starten we
 * meteen de cloudrun. Eerder probeerde de site het eerst zelf, voor álle
 * campagnes, en schreef dan "yt-dlp is niet geïnstalleerd" als fout bij elke
 * campagne weg.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  if (process.env.VERCEL) return NextResponse.json(await naarDeCloud(params.id));
  try {
    const r = await haalNieuweBronvideos({ campaignId: params.id });
    const vanCampagne = r.toegevoegd.length;

    // Ontbreekt lokaal het gereedschap, dan is dit geen inhoudelijk probleem
    // maar een omgeving zonder de juiste tools: dan de cloud.
    const alleenGeenTools =
      vanCampagne === 0 &&
      r.fouten.length > 0 &&
      r.fouten.every((f) => /yt-dlp|gdown|ENOENT|spawn|not found|niet gevonden|niet geïnstalleerd/i.test(f));
    if (alleenGeenTools) return NextResponse.json(await naarDeCloud(params.id));

    return NextResponse.json({
      melding:
        vanCampagne > 0
          ? `${vanCampagne} nieuwe video('s) opgehaald.` + (r.fouten.length ? ` ${r.fouten.length} probleem(en) — zie hieronder.` : '')
          : 'Geen nieuwe video\'s gevonden.' + (r.fouten.length ? ` ${r.fouten.length} probleem(en) — zie hieronder.` : ''),
      toegevoegd: r.toegevoegd,
      fouten: r.fouten,
    });
  } catch (e) {
    const bericht = e instanceof Error ? e.message : String(e);
    if (/yt-dlp|gdown|ENOENT|niet gevonden|niet geïnstalleerd|spawn/i.test(bericht)) {
      return NextResponse.json(await naarDeCloud(params.id));
    }
    return NextResponse.json({ error: bericht }, { status: 500 });
  }
}

async function naarDeCloud(campaignId: string) {
  const gestart = await startCloudRun('ai-jobs.yml');
  // Optimistisch: de klik zélf is het startmoment. De worker overschrijft
  // dit zodra hij deze campagne daadwerkelijk oppakt (dat kan een minuut
  // of twee duren door de installatiestappen van de workflow), en wist
  // het weer zodra hij klaar is. Zonder dit zag je na de klik niets meer
  // gebeuren totdat de nieuwe video's er ineens waren.
  if (gestart) {
    await db().from('campaigns').update({ kanaal_check_gestart_at: new Date().toISOString() }).eq('id', campaignId);
  }
  return {
    inWachtrij: true,
    melding: gestart
      ? 'Ophalen gestart in de cloud (de site kan zelf geen video downloaden); over een paar minuten staan ze hier.'
      : 'Ophalen staat klaar voor de volgende cloudrun.',
  };
}
