import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { SchemaValidationError, structuredCall } from '@/lib/claude';
import { db } from '@/lib/supabase';
import { CLAUDE_LICHT_MODEL } from '@/lib/env';

export const maxDuration = 120;

const suggestieSchema = z.object({
  zoektermen: z.array(z.object({ term: z.string(), waarom: z.string() })).max(8),
});

const SYSTEM = `Je stelt zoektermen voor waarmee een research-agent op TikTok, Reels en YouTube Shorts naar goed presterende content zoekt binnen één thema.

Regels:
- Termen zijn zoals een kijker of maker ze zou intypen, niet zoals een marketeer ze zou schrijven.
- Nederlands, tenzij het thema duidelijk internationaal is.
- Concreet en gangbaar: liever "geld besparen tips" dan "financiële optimalisatie".
- Vermijd termen die te breed zijn (één woord als "geld") of te smal (één specifieke video).
- Gebruik de meegeleverde best presterende posts als aanwijzing voor wat in dit thema aanslaat, maar kopieer geen hele titels.
- Stel alleen termen voor die nog niet in de huidige lijst staan.`;

/**
 * Stelt extra zoektermen voor per thema, op basis van wat de scout in dat thema
 * al zag werken. Zo hoeft niemand te bedenken waar de research op moet zoeken;
 * de tool leidt dat af uit wat er daadwerkelijk presteert.
 *
 * Slaat niets op: de voorstellen gaan terug naar de UI, waar je ze met één klik
 * overneemt (de mens beslist, sectie 3).
 */
export async function POST(req: NextRequest) {
  const { slug } = (await req.json()) as { slug?: string };
  if (!slug) return NextResponse.json({ error: 'slug is verplicht' }, { status: 400 });

  const supabase = db();

  const [themeRes, findsRes] = await Promise.all([
    supabase.from('themes').select('*').eq('slug', slug).single(),
    supabase
      .from('scout_finds')
      .select('caption, handle, platform, outlier_score')
      .eq('theme', slug)
      .order('outlier_score', { ascending: false, nullsFirst: false })
      .limit(25),
  ]);
  if (themeRes.error) return NextResponse.json({ error: themeRes.error.message }, { status: 404 });

  const thema = themeRes.data;
  const finds = findsRes.data ?? [];

  try {
    const result = await structuredCall({
      system: SYSTEM,
      user: `THEMA: ${thema.name}${thema.description ? ` — ${thema.description}` : ''}

HUIDIGE ZOEKTERMEN:
${(thema.zoektermen as string[]).map((z) => `- ${z}`).join('\n') || '(nog geen)'}

WAT IN DIT THEMA AL GOED PRESTEERDE (van de scout):
${
  finds.length > 0
    ? finds.map((f) => `- [${f.platform}, ${f.outlier_score}x] ${f.caption ?? ''} (@${f.handle})`).join('\n')
    : '(nog niets gevonden — baseer je dan op het thema zelf)'
}`,
      schema: suggestieSchema,
      toolName: 'lever_zoektermen',
      toolDescription: 'Lever voorgestelde zoektermen voor dit thema.',
      maxTokens: 4000,
      effort: 'medium',
      operation: 'theme_suggest',
      model: CLAUDE_LICHT_MODEL,
    });

    const bestaand = new Set((thema.zoektermen as string[]).map((z) => z.toLowerCase()));
    const nieuw = result.zoektermen.filter((z) => !bestaand.has(z.term.toLowerCase()));

    return NextResponse.json({ suggesties: nieuw, gebaseerd_op: finds.length });
  } catch (e) {
    if (e instanceof SchemaValidationError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
