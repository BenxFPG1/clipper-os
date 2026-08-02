import { NextResponse } from 'next/server';
import { db, one } from '@/lib/supabase';
import { loadVault } from '@/lib/vault';
import type { Script } from '@/lib/scriptwriter';

/**
 * Zet het nieuwste script van een briefing om in een clips-rij. Daarmee loopt een
 * zelfgemaakte video mee in dezelfde tracking en dus in dezelfde retro als een
 * geknipte clip — anders leert het systeem maar van de helft van het werk.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = db();

  // Zonder scriptId pakken we de nieuwste variant; mét scriptId de gekozen.
  const body = (await req.json().catch(() => ({}))) as { scriptId?: string };

  let query = supabase
    .from('brief_scripts')
    .select('id, script, briefs(titel)')
    .eq('brief_id', params.id);
  if (body.scriptId) query = query.eq('id', body.scriptId);
  const { data: scriptRow, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!scriptRow) {
    return NextResponse.json({ error: 'Deze opdracht heeft nog geen script.' }, { status: 400 });
  }

  const { data: bestaand } = await supabase
    .from('clips')
    .select('id')
    .eq('brief_script_id', scriptRow.id)
    .maybeSingle();
  if (bestaand) {
    return NextResponse.json({ clip: bestaand, alBestaand: true });
  }

  const script = scriptRow.script as Script;

  // Het model kan een slug verzinnen die niet in de vault staat. Die zetten we op
  // null in plaats van de insert te laten stuklopen op de foreign key; de clip is
  // dan nog steeds te tracken, alleen niet te groeperen in de retro.
  const vault = await loadVault();
  const structure = vault.structures.some((s) => s.slug === script.structure_type)
    ? script.structure_type
    : null;
  const hook = vault.hooks.some((h) => h.slug === script.hook.type) ? script.hook.type : null;

  const titel = one<{ titel: string }>(scriptRow.briefs)?.titel ?? 'Script';

  const { data: clip, error: insertError } = await supabase
    .from('clips')
    .insert({
      brief_script_id: scriptRow.id,
      bron: 'script',
      plan_index: 0,
      titel_intern: titel,
      structure_type: structure,
      hook_type: hook,
      hook_text: script.hook.tekst_overlay,
      status: 'planned',
    })
    .select()
    .single();
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  await supabase.from('briefs').update({ status: 'goedgekeurd' }).eq('id', params.id);

  return NextResponse.json({
    clip,
    waarschuwing:
      structure && hook
        ? null
        : 'Structuur of hook stond niet in de vault; die velden zijn leeg gelaten zodat de retro er niet op groepeert.',
  });
}
