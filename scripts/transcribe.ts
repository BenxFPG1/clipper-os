import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { transcribeYoutube, transcribeLocalFile } from '../src/lib/ingest/whisper';
import { renderTranscript, transcriptDuration } from '../src/lib/ingest/transcript';
import { db } from '../src/lib/supabase';

/**
 * Bouwt zelf een transcript. Handig voor lange video's: dit loopt buiten de
 * webserver om en heeft dus geen last van request-timeouts.
 *
 *   npm run transcribe -- "https://youtube.com/watch?v=..." --campaign <uuid>
 *   npm run transcribe -- ./audio.m4a --out transcript.txt
 */
async function main() {
  const [input, ...rest] = process.argv.slice(2);
  if (!input) {
    console.error('Gebruik: npm run transcribe -- <youtube-url|audiobestand> [--campaign <uuid>] [--out <bestand>]');
    process.exit(1);
  }

  const campaignId = valueOf(rest, '--campaign');
  const outFile = valueOf(rest, '--out');
  const isUrl = /^https?:\/\//.test(input);

  console.log(`Transcriberen: ${input}`);
  const result = isUrl
    ? await transcribeYoutube(input)
    : { segments: await transcribeLocalFile(input), title: null, durationSeconds: null };

  const duration = result.durationSeconds ?? Math.round(transcriptDuration(result.segments));
  console.log(`Klaar: ${result.segments.length} segmenten, ${Math.round(duration / 60)} minuten.`);

  if (outFile) {
    writeFileSync(outFile, renderTranscript(result.segments));
    console.log(`Weggeschreven naar ${outFile}`);
  }

  if (campaignId) {
    const { data, error } = await db()
      .from('videos')
      .insert({
        campaign_id: campaignId,
        title: result.title ?? input,
        source_url: isUrl ? input : null,
        duration_seconds: duration,
        transcript: result.segments,
        transcript_raw: JSON.stringify(result.segments),
        transcript_source: 'whisper',
      })
      .select()
      .single();
    if (error) throw error;
    console.log(`Video toegevoegd: ${data.id}`);
  }

  if (!outFile && !campaignId) {
    console.log('\n' + renderTranscript(result.segments));
  }
}

function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
