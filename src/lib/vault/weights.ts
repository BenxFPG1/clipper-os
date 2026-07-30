import { db } from '../supabase';

export type Entity = 'structure' | 'hook';
export const ALL = 'all';
/**
 * Hoe sterk kennis uit andere thema's meetelt als er voor deze combinatie nog
 * geen eigen data is. 0 = negeren, 1 = even zwaar als eigen themakennis.
 */
export const CROSS_THEMA_DEMPING = 0.5;

export type WeightRow = {
  entity: Entity;
  entity_key: string;
  platform: string;
  theme: string;
  weight: number;
  eigen_n: number;
  eigen_mediaan: number | null;
  extern_n: number;
  extern_mediaan: number | null;
  version: number;
};

/**
 * Gewichten per structuur/hook, uitgesplitst naar platform en thema.
 *
 * Wat werkt in comedy werkt niet in financiën, en wat werkt op TikTok werkt
 * niet op Shorts. Daarom is één globaal gewicht per hook niet genoeg. Tegelijk
 * hebben we voor de meeste combinaties (nog) te weinig data, dus vallen we
 * netjes terug: specifiek → platform-breed → thema-breed → algemeen.
 */
export class WeightIndex {
  private readonly index = new Map<string, WeightRow>();

  constructor(rows: WeightRow[]) {
    for (const row of rows) {
      this.index.set(key(row.entity, row.entity_key, row.platform, row.theme), row);
    }
  }

  /** Het gewicht dat geldt voor deze combinatie, inclusief terugval. */
  resolve(entity: Entity, entityKey: string, platform: string | null, theme: string | null) {
    const p = platform ?? ALL;
    const t = theme ?? ALL;

    const kandidaten: [string, string, string, number][] = [
      [p, t, 'exact', 1],
      [p, ALL, 'platform', 1],
      [ALL, t, 'thema', 1],
      // Algemene kennis komt uit alle niches door elkaar. Die gooien we niet
      // weg — een hook die in financien werkt is een echte meting — maar we
      // trekken hem richting neutraal, zodat kennis uit een ander vakgebied
      // je keuzes hooguit bijstuurt en niet bepaalt.
      [ALL, ALL, 'algemeen (gedempt)', CROSS_THEMA_DEMPING],
    ];

    for (const [pl, th, herkomst, demping] of kandidaten) {
      const row = this.index.get(key(entity, entityKey, pl, th));
      if (!row) continue;
      const ruw = Number(row.weight);
      const gewicht = demping === 1 ? ruw : 0.5 + (ruw - 0.5) * demping;
      return { weight: gewicht, herkomst, row };
    }
    return { weight: 0.5, herkomst: 'standaard', row: null };
  }

  /** Alle rijen voor een specifieke combinatie, voor het vault-scherm. */
  rowsFor(platform: string, theme: string): WeightRow[] {
    return [...this.index.values()].filter((r) => r.platform === platform && r.theme === theme);
  }

  get all(): WeightRow[] {
    return [...this.index.values()];
  }
}

function key(entity: string, entityKey: string, platform: string, theme: string): string {
  return `${entity}|${entityKey}|${platform}|${theme}`;
}

export async function loadWeights(): Promise<WeightIndex> {
  const { data, error } = await db().from('vault_weights').select('*');
  if (error) throw error;
  return new WeightIndex((data ?? []) as WeightRow[]);
}

/**
 * Zet een gewicht voor een combinatie. Wordt alleen aangeroepen na goedkeuring
 * van een retro-voorstel; de agents muteren de vault nooit zelf.
 */
export async function upsertWeight(
  row: Omit<WeightRow, 'version'> & { evidence?: unknown },
): Promise<void> {
  const supabase = db();

  const { data: bestaand } = await supabase
    .from('vault_weights')
    .select('version')
    .eq('entity', row.entity)
    .eq('entity_key', row.entity_key)
    .eq('platform', row.platform)
    .eq('theme', row.theme)
    .maybeSingle();

  const { error } = await supabase.from('vault_weights').upsert(
    {
      entity: row.entity,
      entity_key: row.entity_key,
      platform: row.platform,
      theme: row.theme,
      weight: row.weight,
      eigen_n: row.eigen_n,
      eigen_mediaan: row.eigen_mediaan,
      extern_n: row.extern_n,
      extern_mediaan: row.extern_mediaan,
      evidence: row.evidence ?? {},
      version: (bestaand?.version ?? 0) + 1,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'entity,entity_key,platform,theme' },
  );
  if (error) throw error;
}
