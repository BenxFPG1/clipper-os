import { db } from '../supabase';
import { loadVault } from '../vault';
import { TranscriptSegment, transcriptDuration } from '../ingest/transcript';
import { generateCharacterMap, generateClipPlan, PROMPT_VERSION } from './index';
import { SCHEMA_VERSION } from './schema';

/**
 * Draait de volledige pipeline voor één video en slaat het resultaat op:
 * character map op de video, het plan in clip_plans, en één clips-rij per clip
 * zodat Marlou meteen statussen en post-URL's kan bijhouden.
 */
export async function runPlannerForVideo(videoId: string, options?: { reuseCharacterMap?: boolean }) {
  const supabase = db();

  const { data: video, error } = await supabase
    .from('videos')
    .select('*, campaigns(platform_rules)')
    .eq('id', videoId)
    .single();
  if (error) throw error;
  if (!video?.transcript) throw new Error('Video heeft nog geen transcript');

  const transcript = video.transcript as TranscriptSegment[];
  const durationSeconds = video.duration_seconds ?? Math.round(transcriptDuration(transcript));
  const vault = await loadVault();

  const characterMap =
    options?.reuseCharacterMap && video.character_map
      ? video.character_map
      : await generateCharacterMap({ title: video.title, durationSeconds, transcript });

  if (characterMap !== video.character_map) {
    await supabase.from('videos').update({ character_map: characterMap }).eq('id', videoId);
  }

  const plan = await generateClipPlan({
    title: video.title,
    durationSeconds,
    transcript,
    campaignRules: (video.campaigns as { platform_rules?: unknown } | null)?.platform_rules ?? {},
    vault,
    characterMap,
  });

  const { data: planRow, error: planError } = await supabase
    .from('clip_plans')
    .insert({
      video_id: videoId,
      prompt_version: PROMPT_VERSION,
      schema_version: SCHEMA_VERSION,
      vault_snapshot: vault,
      plan,
    })
    .select()
    .single();
  if (planError) throw planError;

  const clipRows = plan.clips.map((clip, index) => ({
    clip_plan_id: planRow.id,
    plan_index: index,
    titel_intern: clip.titel_intern,
    structure_type: clip.structure_type,
    hook_type: clip.hook.type,
    hook_text: clip.hook.tekst_overlay,
    status: 'planned' as const,
  }));

  const { error: clipsError } = await supabase.from('clips').insert(clipRows);
  if (clipsError) throw clipsError;

  return { planId: planRow.id, plan, characterMap, clipCount: plan.clips.length };
}
