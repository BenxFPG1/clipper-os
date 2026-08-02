import { db } from '../supabase';
import { optionalEnv } from '../env';

export type AiJobSoort = 'clip_plan' | 'scripts' | 'concepten';

/**
 * Denkwerk (clip-plannen, scripts, concepten) kan niet op de live site: die
 * heeft geen Claude-CLI en bewust geen API-key, zodat alles op het abonnement
 * draait. De site zet daarom een opdracht in de wachtrij en GitHub Actions
 * voert hem uit — hetzelfde model als de montages.
 */
export async function queueAiJob(
  soort: AiJobSoort,
  doelId: string,
  parameters: Record<string, unknown> = {},
): Promise<{ jobId: string; directGestart: boolean }> {
  const { data, error } = await db()
    .from('ai_jobs')
    .insert({ soort, doel_id: doelId, parameters })
    .select('id')
    .single();
  if (error) throw error;

  return { jobId: data.id as string, directGestart: await startCloudRun('ai-jobs.yml') };
}

/**
 * Zet de workflow meteen aan in plaats van te wachten op de geplande run.
 * Best-effort: lukt dit niet (token verlopen, GitHub plat), dan pakt de
 * geplande run de opdracht alsnog op — de wachtrij is de waarheid.
 */
export async function startCloudRun(workflow: string): Promise<boolean> {
  const token = optionalEnv('GH_DISPATCH_TOKEN');
  if (!token) return false;

  try {
    const repo = optionalEnv('GH_REPO', 'BenxFPG1/clipper-os');
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'master' }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/** Draait het denkwerk lokaal als de Claude-CLI beschikbaar is, anders via de wachtrij. */
export function heeftLokaleClaude(): boolean {
  return optionalEnv('CLAUDE_BACKEND', 'api') === 'claude-code'
    ? Boolean(optionalEnv('CLAUDE_CODE_OAUTH_TOKEN')) || !isServerless()
    : Boolean(optionalEnv('ANTHROPIC_API_KEY'));
}

function isServerless(): boolean {
  return Boolean(process.env.VERCEL);
}
