import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { db } from '../src/lib/supabase';
import { Shot, maakRuweMontage, ruimBronnenOp } from '../src/lib/roughcut';

/**
 * Maakt ruwe montages van een clip-plan: elk fragment uit het plan geknipt en
 * achter elkaar gezet, verticaal, klaar om in CapCut te openen en af te maken.
 *
 *   npm run roughcut -- <video-id>              alle clips uit het nieuwste plan
 *   npm run roughcut -- <video-id> --clip 3     alleen clip 3
 *   npm run roughcut -- --opruimen              gedownloade bronvideo's weggooien
 */
const UITVOERMAP = join(homedir(), 'Movies', 'Clipper OS');
const WERKMAP = join(UITVOERMAP, '.werk');

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--opruimen')) {
    const n = await ruimBronnenOp(WERKMAP);
    console.log(`${n} gedownloade bronvideo('s) opgeruimd.`);
    return;
  }

  const videoId = args[0];
  if (!videoId) {
    console.error('Gebruik: npm run roughcut -- <video-id> [--clip <nummer>] [--horizontaal]');
    process.exit(1);
  }

  const alleenClip = args.includes('--clip') ? Number(args[args.indexOf('--clip') + 1]) : null;
  const verticaal = !args.includes('--horizontaal');

  const supabase = db();

  const { data: video, error } = await supabase
    .from('videos')
    .select('id, title, source_url')
    .eq('id', videoId)
    .single();
  if (error) throw error;
  if (!video.source_url) throw new Error('Deze video heeft geen bron-URL; ruw monteren kan alleen vanaf de bron.');

  const { data: plan, error: planError } = await supabase
    .from('clip_plans')
    .select('id, plan, created_at')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (planError) throw new Error('Geen clip-plan gevonden voor deze video.');

  const clips = ((plan.plan as { clips?: unknown[] }).clips ?? []) as {
    titel_intern: string;
    shots: Shot[];
  }[];

  const teDoen = alleenClip !== null ? [clips[alleenClip - 1]].filter(Boolean) : clips;
  if (teDoen.length === 0) throw new Error('Geen clips om te monteren.');

  await mkdir(UITVOERMAP, { recursive: true });
  console.log(`${teDoen.length} clip(s) uit "${video.title}"\nUitvoer: ${UITVOERMAP}\n`);

  for (const [i, clip] of teDoen.entries()) {
    const nummer = alleenClip ?? i + 1;
    const naam = `${String(nummer).padStart(2, '0')} - ${veiligeNaam(clip.titel_intern)}.mp4`;
    const doel = join(UITVOERMAP, naam);

    console.log(`[${i + 1}/${teDoen.length}] ${clip.titel_intern}`);
    try {
      const { duur } = await maakRuweMontage({
        sourceUrl: video.source_url,
        shots: clip.shots,
        outputPad: doel,
        werkmap: join(WERKMAP, videoId),
        verticaal,
        onVoortgang: (m) => console.log(`   ${m}`),
      });
      console.log(`   klaar: ${naam} (${duur}s)\n`);
    } catch (e) {
      console.error(`   MISLUKT: ${e instanceof Error ? e.message : e}\n`);
    }
  }

  console.log(`Klaar. Open de map en werk ze af in CapCut.`);
  console.log(`Bronvideo's opruimen als je klaar bent: npm run roughcut -- --opruimen`);
}

function veiligeNaam(naam: string): string {
  return naam.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 50).trim() || 'clip';
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
