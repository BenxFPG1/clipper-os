import Link from 'next/link';
import { db } from '@/lib/supabase';
import { NewBriefForm } from './new-brief-form';

export const dynamic = 'force-dynamic';

export default async function OpdrachtenPage() {
  const supabase = db();
  const [briefs, campaigns] = await Promise.all([
    supabase.from('briefs').select('id, titel, platform, doel, status, created_at').order('created_at', { ascending: false }),
    supabase.from('campaigns').select('id, name').eq('status', 'active'),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Opdrachten</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Stuur een briefing in en krijg een volledig script terug, gebouwd op de gemeten kennis in de vault.
        </p>
      </div>

      <NewBriefForm campaigns={campaigns.data ?? []} />

      <ul className="space-y-2">
        {(briefs.data ?? []).map((b) => (
          <li key={b.id} className="rounded border border-neutral-800 px-4 py-3">
            <Link href={`/opdrachten/${b.id}`} className="font-medium hover:underline">
              {b.titel}
            </Link>
            <div className="text-sm text-neutral-400">
              {b.platform ?? 'platform onbepaald'} · {b.doel ?? 'geen doel opgegeven'} · {b.status}
            </div>
          </li>
        ))}
        {(briefs.data ?? []).length === 0 && (
          <li className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
            Nog geen opdrachten.
          </li>
        )}
      </ul>
    </div>
  );
}
