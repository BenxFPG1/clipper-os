import { db } from '@/lib/supabase';
import { OutlierFeed } from './outlier-feed';

export const dynamic = 'force-dynamic';

/**
 * De outlier-feed: alles wat de scout op de platforms vond, doorzoekbaar en
 * sorteerbaar. Dit is het scherm waar je 's ochtends naar kijkt — niet de
 * instellingen, maar de vondsten zelf.
 */
export default async function OutliersPage() {
  const supabase = db();

  const [finds, themes] = await Promise.all([
    supabase
      .from('scout_finds')
      .select('*')
      .order('outlier_score', { ascending: false, nullsFirst: false })
      .limit(300),
    supabase.from('themes').select('slug, name').order('name'),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Outliers</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Posts die het veel beter deden dan normaal voor hun eigen account. Filter op wat je zoekt en maak er met één
          klik een script van.
        </p>
      </div>

      <OutlierFeed finds={finds.data ?? []} themes={themes.data ?? []} />
    </div>
  );
}
