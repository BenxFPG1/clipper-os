import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { SchemaValidationError, structuredCall } from '@/lib/claude';
import { db } from '@/lib/supabase';

export const maxDuration = 120;

const campagneSchema = z.object({
  name: z.string(),
  cpm_eur: z.number().nullable(),
  budget_eur: z.number().nullable(),
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

const IMPORT_SYSTEM = `Je zet de tekst van een clipping-campagne (bijvoorbeeld van ClipArmy of Whop) om naar gestructureerde campagneregels. Neem alleen over wat er letterlijk staat; verzin geen regels. CPM en bedragen in euro's. Wat je niet zeker weet zet je in "onduidelijk" zodat een mens het kan controleren.`;

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
    const parsed = await structuredCall({
      system: IMPORT_SYSTEM,
      user: body.tekst.trim().slice(0, 20000),
      schema: campagneSchema,
      toolName: 'lever_campagne',
      toolDescription: 'Lever de gestructureerde campagne.',
      maxTokens: 4000,
      effort: 'medium',
      operation: 'campaign_import',
    });

    const { data, error } = await db()
      .from('campaigns')
      .insert({
        name: parsed.name,
        cpm_eur: parsed.cpm_eur ?? 0.5,
        budget_eur: parsed.budget_eur,
        platform_rules: parsed.platform_rules,
        status: 'active',
      })
      .select()
      .single();
    if (error) throw error;

    return NextResponse.json({ campaign: data, onduidelijk: parsed.onduidelijk });
  } catch (e) {
    if (e instanceof SchemaValidationError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
