import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { db } from '../src/lib/supabase';
import { parseManualTranscript, transcriptDuration } from '../src/lib/ingest/transcript';
import { SEED_CAMPAIGN } from '../src/lib/vault/seed-data';

/**
 * Laadt eval-case #1 uit een transcriptbestand.
 *
 *   npx tsx scripts/seed-eval-case.ts ./transcripts/supergaande-raad-de-vrouw.txt
 *
 * De verwachte eigenschappen komen uit sectie 10: de gezichtsmasker-scene rond
 * 16:36, de AI/Gemini-reveal rond 34:44, en minstens één edit die fragmenten van
 * meer dan 15 minuten uit elkaar combineert.
 */
const EXPECTED_PROPERTIES = {
  min_clips: 10,
  gouden_momenten: [
    { naam: 'gezichtsmasker', seconde: 16 * 60 + 36, tolerantie_seconden: 90 },
    { naam: 'ai_gemini_reveal', seconde: 34 * 60 + 44, tolerantie_seconden: 90 },
  ],
  min_fragment_afstand_seconden: 15 * 60,
};

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Gebruik: npx tsx scripts/seed-eval-case.ts <pad-naar-transcript.txt>');
    process.exit(1);
  }

  const segments = parseManualTranscript(readFileSync(path, 'utf8'));
  if (segments.length === 0) {
    console.error('Geen tijdcodes gevonden. Verwacht regels als "0:07 tekst".');
    process.exit(1);
  }

  const name = 'Supergaande — Raad de Vrouw';
  const supabase = db();

  const { data: existing } = await supabase.from('eval_cases').select('id').eq('name', name).maybeSingle();
  const row = {
    name,
    input_transcript: segments,
    duration_seconds: Math.round(transcriptDuration(segments)),
    campaign_rules: SEED_CAMPAIGN.platform_rules,
    expected_properties: EXPECTED_PROPERTIES,
  };

  const { error } = existing
    ? await supabase.from('eval_cases').update(row).eq('id', existing.id)
    : await supabase.from('eval_cases').insert(row);
  if (error) throw error;

  console.log(`Eval-case "${name}" ${existing ? 'bijgewerkt' : 'aangemaakt'}: ${segments.length} segmenten, ${row.duration_seconds}s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
