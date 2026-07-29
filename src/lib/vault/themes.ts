import { db } from '../supabase';

export type Theme = {
  slug: string;
  name: string;
  description: string | null;
  zoektermen: string[];
  actief: boolean;
};

/**
 * Thema's zijn de niches waarin we werken. Ze bepalen twee dingen: waar de
 * scout op zoekt, en onder welke noemer de opgedane kennis wordt opgeslagen.
 * Zo deelt elk account dezelfde vault, maar krijgt comedy andere gewichten dan
 * financiën.
 */
export async function loadThemes(alleenActief = true): Promise<Theme[]> {
  let query = db().from('themes').select('*').order('name');
  if (alleenActief) query = query.eq('actief', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Theme[];
}

export async function themeSlugs(): Promise<string[]> {
  return (await loadThemes()).map((t) => t.slug);
}

const CLASSIFY_INSTRUCTIE = `Je krijgt een lijst thema's en een lijst posts. Bepaal per post welk thema het beste past.
- Kies uitsluitend uit de aangeboden thema-slugs, of "onbekend" als er echt geen past.
- Ga af op de titel/caption en het account. Verzin niets.`;

export function buildClassifyPrompt(themes: Theme[], posts: { post_url: string; caption: string | null; handle: string | null }[]): { system: string; user: string } {
  return {
    system: CLASSIFY_INSTRUCTIE,
    user: `THEMA'S:\n${themes
      .map((t) => `- ${t.slug}: ${t.name}${t.description ? ` — ${t.description}` : ''}`)
      .join('\n')}\n\nPOSTS:\n${JSON.stringify(
      posts.map((p) => ({ post_url: p.post_url, account: p.handle, titel: p.caption })),
      null,
      2,
    )}`,
  };
}
