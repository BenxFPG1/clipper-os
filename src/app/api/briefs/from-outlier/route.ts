import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { Platform, getMetricsProvider } from '@/lib/tracking/provider';

export const maxDuration = 120;

type Decoded = {
  hook_type?: string;
  hook_beschrijving?: string;
  structuur?: string;
  waarom_het_werkt?: string;
};

/**
 * Zet een gevonden outlier om in een opdracht. Het format dat bij iemand anders
 * werkte wordt de briefing; de scriptwriter maakt er vervolgens ons eigen
 * script van, met onze vault en campagneregels.
 *
 * Waar mogelijk halen we het transcript van de originele post erbij: dan zie je
 * niet alleen wát er goed liep maar ook hoe de eerste seconden klonken.
 */
export async function POST(req: NextRequest) {
  const { findId } = (await req.json()) as { findId?: string };
  if (!findId) return NextResponse.json({ error: 'findId is verplicht' }, { status: 400 });

  const supabase = db();

  const { data: find, error } = await supabase.from('scout_finds').select('*').eq('id', findId).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });

  const decoded = (find.decoded ?? {}) as Decoded;

  // Transcript is optioneel: kost een credit en werkt alleen op TikTok.
  let transcript: string | null = (find.transcript as string | null) ?? null;
  if (!transcript) {
    try {
      const provider = getMetricsProvider();
      transcript = (await provider.fetchTranscript?.(find.post_url, find.platform as Platform)) ?? null;
      if (transcript) await supabase.from('scout_finds').update({ transcript }).eq('id', findId);
    } catch {
      // Zonder transcript kunnen we prima door; het is een verrijking.
    }
  }

  const briefing = [
    `Dit format werkte aantoonbaar bij een ander account en willen we in onze eigen vorm maken.`,
    ``,
    `Bron: ${find.post_url} (@${find.handle}, ${find.platform})`,
    `Prestatie: ${find.outlier_score}× de mediaan van dat account${
      find.views ? `, ${Number(find.views).toLocaleString('nl-NL')} views` : ''
    }.`,
    ``,
    `Caption van het origineel: ${find.caption ?? '(geen)'}`,
    decoded.hook_beschrijving ? `Hook die daar gebruikt is: ${decoded.hook_beschrijving}` : '',
    decoded.structuur ? `Structuur: ${decoded.structuur}` : '',
    decoded.waarom_het_werkt ? `Waarom het werkte: ${decoded.waarom_het_werkt}` : '',
    transcript ? `\nTranscript van het origineel:\n${transcript.slice(0, 4000)}` : '',
    ``,
    `Maak hier onze eigen versie van: neem het onderliggende patroon over, niet de inhoud.`,
  ]
    .filter(Boolean)
    .join('\n');

  const { data: brief, error: insertError } = await supabase
    .from('briefs')
    .insert({
      titel: `Naar voorbeeld van @${find.handle}: ${(find.caption ?? '').slice(0, 60) || 'outlier'}`,
      briefing,
      doel: 'views',
      platform: find.platform,
      theme: find.theme,
      duur_seconden: 30,
    })
    .select()
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
  return NextResponse.json({ briefId: brief.id, transcriptGevonden: Boolean(transcript) });
}
