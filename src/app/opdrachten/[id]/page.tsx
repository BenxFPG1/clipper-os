import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase';
import type { Script } from '@/lib/scriptwriter';
import { datumTijd } from '@/lib/format';
import { GenerateScriptButton } from './generate-script-button';
import { PublishButton, type PublishedClip } from './publish-button';
import { FeedbackForm } from './feedback-form';
import { ScriptWeergave } from './script-weergave';

export const dynamic = 'force-dynamic';

/**
 * Eén opdracht, meerdere verhaallijnen: elke gegenereerde variant staat hier
 * als eigen blok met stijl en verhaallijn, zodat je kiest in plaats van hoopt
 * dat de ene poging goed was. Publiceren en feedback geven kan per variant.
 */
export default async function BriefDetailPage({ params }: { params: { id: string } }) {
  const supabase = db();

  const { data: brief } = await supabase.from('briefs').select('*').eq('id', params.id).single();
  if (!brief) notFound();

  const { data: scripts } = await supabase
    .from('brief_scripts')
    .select('id, script, prompt_version, feedback, created_at')
    .eq('brief_id', params.id)
    .order('created_at', { ascending: false });

  const scriptIds = (scripts ?? []).map((s) => s.id);
  const { data: clips } = scriptIds.length
    ? await supabase.from('clips').select('id, status, post_url, brief_script_id').in('brief_script_id', scriptIds)
    : { data: [] };
  const clipPerScript = new Map((clips ?? []).map((c) => [c.brief_script_id as string, c as unknown as PublishedClip]));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{brief.titel}</h1>
        <p className="text-sm text-neutral-400">
          {brief.platform ?? 'platform onbepaald'} ·{' '}
          {brief.duur_seconden ? `${brief.duur_seconden}s` : 'duur onbepaald'} ·{' '}
          {brief.doel ?? 'geen doel opgegeven'} · aangemaakt {datumTijd(brief.created_at)}
        </p>
      </div>

      <section className="rounded border border-neutral-800 p-4">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500">Briefing</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm">{brief.briefing}</p>
      </section>

      <GenerateScriptButton briefId={brief.id} hasScript={(scripts?.length ?? 0) > 0} versies={scripts?.length ?? 0} />

      {(scripts ?? []).length > 0 ? (
        <section className="space-y-4">
          {(scripts ?? []).map((rij, i) => {
            const script = rij.script as Script;
            const stijl = script.zelfkritiek?.stijl ?? script.structure_type;
            return (
              <details key={rij.id} open={i === 0} className="rounded border border-neutral-800">
                <summary className="cursor-pointer px-4 py-3">
                  <span className="font-medium">
                    Verhaallijn {(scripts ?? []).length - i}: {stijl}
                  </span>
                  <span className="ml-2 text-sm text-neutral-400">
                    &ldquo;{script.hook.tekst_overlay}&rdquo; · {datumTijd(rij.created_at)}
                  </span>
                </summary>
                <div className="space-y-5 border-t border-neutral-900 p-4">
                  <PublishButton
                    briefId={brief.id}
                    scriptId={rij.id}
                    clip={clipPerScript.get(rij.id) ?? null}
                  />
                  <ScriptWeergave script={script} />
                  <FeedbackForm
                    briefId={brief.id}
                    scriptId={rij.id}
                    bestaande={(rij as { feedback?: string | null }).feedback ?? null}
                  />
                </div>
              </details>
            );
          })}
        </section>
      ) : (
        <p className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
          Nog geen verhaallijnen. Genereer er hierboven meteen drie.
        </p>
      )}
    </div>
  );
}
