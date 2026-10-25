import { db } from '../supabase';
import { startRenderCloudRun } from '../tracking/leerlus';

/**
 * Direct renderen na een plan, in plaats van te wachten op de uurcheck van
 * roughcut.yml. Per clip een eigen opdracht (dan renderen de matrix-runners
 * ze naast elkaar), daarna meteen een render-run starten.
 *
 * Uit tenzij AUTO_RENDER_NA_PLAN=1; AUTO_RENDER_CLIPS = hoeveel clips (de
 * sterkste eerst; standaard alle). Bestaande wachtende/lopende opdrachten
 * voor dezelfde clip worden niet verdubbeld.
 */
export async function renderNaPlan(videoId: string, aantalClips: number): Promise<{ opdrachten: number; gestart: boolean } | null> {
  if (process.env.AUTO_RENDER_NA_PLAN !== '1' || aantalClips <= 0) return null;
  const max = Number(process.env.AUTO_RENDER_CLIPS ?? '0') || aantalClips;
  const supabase = db();
  const { data: lopend } = await supabase
    .from('render_jobs')
    .select('clip_index')
    .eq('video_id', videoId)
    .in('status', ['wachtend', 'bezig']);
  const bezet = new Set((lopend ?? []).map((r) => r.clip_index as number | null));
  const nieuw = Array.from({ length: Math.min(max, aantalClips) }, (_, i) => i + 1)
    .filter((n) => !bezet.has(n) && !bezet.has(null))
    .map((n) => ({ video_id: videoId, clip_index: n, titel: `auto na plan: clip ${n}` }));
  if (nieuw.length) {
    const { error } = await supabase.from('render_jobs').insert(nieuw);
    if (error) throw error;
  }
  const gestart = nieuw.length ? await startRenderCloudRun() : false;
  return { opdrachten: nieuw.length, gestart };
}
