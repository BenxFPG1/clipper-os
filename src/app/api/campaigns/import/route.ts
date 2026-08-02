import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { SchemaValidationError, structuredCall } from '@/lib/claude';
import { db } from '@/lib/supabase';
import { startCloudRun } from '@/lib/jobs';

export const maxDuration = 120;

const campagneSchema = z.object({
  name: z.string(),
  cpm_eur: z.number().nullable(),
  budget_eur: z.number().nullable(),
  bron_kanalen: z
    .array(z.string())
    .describe(
      'Alle URLs van het bronmateriaal. LET OP: noemt de campagne concrete video-URLs (youtu.be/... of watch?v=...), zet dan ALLEEN die video-URLs erin — dat is het bronmateriaal. Alleen als er geen losse video genoemd wordt en de campagne over een heel kanaal gaat, zet je de kanaal- of playlist-URL erin.',
    ),
  platform_rules: z.object({
    platforms: z.array(z.string()),
    min_seconds: z.number().nullable(),
    payout_from_views: z.number().nullable(),
    max_eur_per_clip: z.number().nullable(),
    tags: z.array(z.string()),
    hashtags: z.array(z.string()),
    description_line: z.string().nullable(),
    forbidden: z.array(z.string()),
    other_rules: z.array(z.string()),
  }),
  onduidelijk: z.array(z.string()),
});

/**
 * Parser zonder AI voor als er geen Claude-backend beschikbaar is (Vercel).
 * Pakt alleen wat met hoge zekerheid uit de tekst te halen is; de rest gaat
 * naar "onduidelijk" voor menselijke controle.
 */
function heuristischeParse(tekst: string): z.infer<typeof campagneSchema> {
  const regels = tekst.split('\n').map((r) => r.trim()).filter(Boolean);
  const onduidelijk: string[] = ['Automatisch geparsed zonder AI — controleer alle regels hieronder.'];

  const naam = regels[0]?.slice(0, 120) ?? 'Nieuwe campagne';

  const getal = (m: RegExpMatchArray | null): number | null =>
    m ? Number(m[1].replace(/\./g, '').replace(',', '.')) : null;

  const cpm = getal(
    tekst.match(/(?:€|\$|EUR|USD)?\s*([\d.,]+)\s*(?:€|\$)?\s*(?:per\s*1[.,]?000|\/\s*1[.,]?000|CPM)/i) ??
      tekst.match(/CPM\D{0,10}([\d.,]+)/i),
  );
  const budget = getal(tekst.match(/budget\D{0,15}([\d.,]+)/i));
  const minSeconden = getal(tekst.match(/min(?:imaal|imum)?\D{0,20}?(\d+)\s*sec/i));
  const maxPerClip = getal(tekst.match(/max(?:imaal|imum)?\D{0,20}?(?:€|\$)\s*([\d.,]+)\s*(?:per\s*(?:clip|video|post))/i));

  // Losse video-URLs zijn het bronmateriaal en hebben voorrang: pakt hij hier
  // het kanaal, dan komen er afleveringen binnen die niet bij de campagne horen.
  const videoUrls = [
    ...(tekst.match(/https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w-]+/gi) ?? []),
    ...(tekst.match(/https?:\/\/youtu\.be\/[\w-]+/gi) ?? []),
  ];

  // Bronnen: alle YouTube-kanaal- en playlist-URLs, anders losse @handles.
  const kanaalUrls = videoUrls.length ? [] : [
    ...(tekst.match(/https?:\/\/(?:www\.)?youtube\.com\/(?:channel\/[\w-]+|@[\w.-]+|c\/[\w.-]+)/gi) ?? []),
    ...(tekst.match(/https?:\/\/(?:www\.)?youtube\.com\/playlist\?list=[\w-]+/gi) ?? []),
  ];
  const handles = videoUrls.length || kanaalUrls.length
    ? []
    : (tekst.match(/(?:^|\s)@([\w.-]{3,30})(?=\s|$)/g) ?? []).map(
        (h) => `https://www.youtube.com/@${h.trim().slice(1)}`,
      );
  const bronKanalen = [...new Set([...videoUrls, ...kanaalUrls, ...handles])];
  if (bronKanalen.length > 0) {
    onduidelijk.push(`Bron(nen) gevonden: ${bronKanalen.join(', ')} — controleer of dit klopt.`);
  }

  const platforms: string[] = [];
  if (/tiktok/i.test(tekst)) platforms.push('tiktok');
  if (/instagram|reels/i.test(tekst)) platforms.push('instagram');
  if (/shorts|youtube/i.test(tekst)) platforms.push('youtube');

  const hashtags = [...new Set(tekst.match(/#[\p{L}\p{N}_]+/gu) ?? [])];
  const verboden = regels.filter((r) => /verboden|niet toegestaan|not allowed|prohibited|geen\s/i.test(r));

  for (const r of regels.slice(1)) {
    const alGedekt =
      verboden.includes(r) || /(€|\$|CPM|budget|per\s*1[.,]?000|#)/i.test(r) || r.length < 8;
    if (!alGedekt) onduidelijk.push(r.slice(0, 200));
  }

  return {
    name: naam,
    cpm_eur: cpm,
    budget_eur: budget,
    bron_kanalen: bronKanalen,
    platform_rules: {
      platforms,
      min_seconds: minSeconden,
      payout_from_views: null,
      max_eur_per_clip: maxPerClip,
      tags: [],
      hashtags,
      description_line: null,
      forbidden: verboden.map((r) => r.slice(0, 200)),
      other_rules: [],
    },
    onduidelijk: onduidelijk.slice(0, 40),
  };
}

const IMPORT_SYSTEM = `Je zet de tekst van een clipping-campagne (bijvoorbeeld van ClipArmy of Whop) om naar gestructureerde campagneregels. Neem alleen over wat er letterlijk staat; verzin geen regels. CPM en bedragen in euro's. Wat je niet zeker weet zet je in "onduidelijk" zodat een mens het kan controleren.

Let extra op het BRONMATERIAAL: campagnes noemen bijna altijd waar de te knippen video's vandaan komen (een YouTube-kanaal, een playlist, een handle als @naam). Noemt de campagne concrete video-URLs, dan zijn DIE het bronmateriaal en zet je alleen die in bron_kanalen — niet het kanaal eromheen, want dan komen er afleveringen binnen die niet bij de campagne horen. Gaat de campagne wél over doorlopende uploads van een kanaal, zet dan de kanaal-URL erin (een losse handle maak je tot https://www.youtube.com/@naam).`;

/**
 * Campagne-import: plak de tekst van een campagnepagina en er wordt een
 * campagne aangemaakt met geparste regels. Bewust een mens in de lus in plaats
 * van een scraper op ClipArmy: hun site scrapen verbiedt de spec, en zo blijft
 * de controle op de regels bij ons liggen.
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
    let parsed: z.infer<typeof campagneSchema>;
    try {
      parsed = await structuredCall({
        system: IMPORT_SYSTEM,
        user: body.tekst.trim().slice(0, 20000),
        schema: campagneSchema,
        toolName: 'lever_campagne',
        toolDescription: 'Lever de gestructureerde campagne.',
        maxTokens: 4000,
        effort: 'medium',
        operation: 'campaign_import',
      });
    } catch (e) {
      // Op Vercel is er geen Claude CLI en (bewust) geen API-key. Dan parsen
      // we de tekst zelf; alles wat de heuristiek niet zeker weet komt in
      // "onduidelijk" zodat een mens het controleert.
      const geenClaude = /Ontbrekende env var|CLI niet gevonden|niet \(meer\) ingelogd/i.test(
        e instanceof Error ? e.message : String(e),
      );
      if (!geenClaude) throw e;
      parsed = heuristischeParse(body.tekst.trim());
    }

    const { data, error } = await db()
      .from('campaigns')
      .insert({
        name: parsed.name,
        cpm_eur: parsed.cpm_eur ?? 0.5,
        budget_eur: parsed.budget_eur,
        platform_rules: parsed.platform_rules,
        bron_kanalen: parsed.bron_kanalen,
        status: 'active',
      })
      .select()
      .single();
    if (error) throw error;

    // Staat er een bronkanaal in? Dan meteen de eerste uploads laten ophalen
    // in de cloud; daar staat yt-dlp en draait de plan-worker toch al.
    const kanaalGestart = parsed.bron_kanalen.length > 0 ? await startCloudRun('ai-jobs.yml') : false;

    return NextResponse.json({
      campaign: data,
      onduidelijk: parsed.onduidelijk,
      bronKanalen: parsed.bron_kanalen,
      kanaalGestart,
    });
  } catch (e) {
    if (e instanceof SchemaValidationError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
