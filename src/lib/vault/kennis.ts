import { db } from '../supabase';

let cache: { tekst: string; tot: number } | null = null;

/**
 * De zelflerende laag van de vault: aanvullingen die de wekelijkse
 * kennis-agent via webresearch heeft bijgeleerd. Wordt achter de vaste
 * kaders geplakt in elke plan-, examen- en scriptcall.
 *
 * Vijf minuten cache: de worker doet veel calls kort na elkaar en de kennis
 * verandert hooguit wekelijks.
 */
export async function geleerdeKennis(): Promise<string> {
  if (cache && Date.now() < cache.tot) return cache.tekst;

  const { data } = await db()
    .from('vault_kennis')
    .select('categorie, titel, inhoud, bron')
    .eq('actief', true)
    .order('created_at');

  const tekst =
    data && data.length > 0
      ? `\n\n=== BIJGELEERDE KENNIS (wekelijkse research-agent) ===\n` +
        data
          .map((k) => `[${k.categorie}] ${k.titel}\n${k.inhoud}${k.bron ? `\n(bron: ${k.bron})` : ''}`)
          .join('\n\n')
      : '';

  cache = { tekst, tot: Date.now() + 5 * 60 * 1000 };
  return tekst;
}
