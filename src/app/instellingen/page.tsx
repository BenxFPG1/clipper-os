import { db } from '@/lib/supabase';
import { laadLeerlus, laadWerkStatus } from '@/lib/status';
import { datumTijd } from '@/lib/format';
import { LeerlusBlok } from '../leerlus-blok';
import { ClipArmyBookmarklet } from '../cliparmy-bookmarklet';
import { ClipArmySessie } from '../cliparmy-sessie';

export const dynamic = 'force-dynamic';

/**
 * Alles wat je instelt en niet dagelijks nodig hebt: de koppeling met
 * ClipArmy, hoeveel de tool vandaag van Claude heeft gebruikt, en waar de
 * tool op dit moment van leert. Stond eerst allemaal op de startpagina.
 */
export default async function InstellingenPage() {
  const [werk, leerlus, sessie] = await Promise.all([
    laadWerkStatus(),
    laadLeerlus(),
    db().from('platform_sessies').select('laatste_check, laatste_fout').eq('platform', 'cliparmy').maybeSingle(),
  ]);
  const { verbruik } = werk;
  const aandeel = verbruik.opdrachtenVandaag / verbruik.dagGrens;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Instellingen</h1>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">ClipArmy</h2>
        <p className="text-sm text-neutral-400">Zo komen nieuwe campagnes vanzelf binnen.</p>
        <ClipArmySessie
          ingesteld={Boolean(sessie.data)}
          laatsteCheck={(sessie.data?.laatste_check as string | null) ?? null}
          laatsteFout={(sessie.data?.laatste_fout as string | null) ?? null}
        />
        <ClipArmyBookmarklet />
      </section>

      <section className="rounded border border-neutral-800 p-4">
        <h2 className="text-lg font-medium">Verbruik vandaag</h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span>
            <span className="font-semibold">{verbruik.zwareCallsVandaag}</span>{' '}
            <span className="text-neutral-400">zware opdrachten (plannen, scripts, concepten)</span>
          </span>
          <span>
            <span className="font-semibold">
              {verbruik.opdrachtenVandaag}/{verbruik.dagGrens}
            </span>{' '}
            <span className="text-neutral-400">van de daggrens</span>
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-neutral-800">
          <div className={`h-full ${aandeel > 0.8 ? 'bg-amber-500' : 'bg-neutral-500'}`} style={{ width: `${Math.min(100, Math.round(aandeel * 100))}%` }} />
        </div>
        {verbruik.laatsteLimiet && (
          <p className="mt-2 text-xs text-amber-300/80">
            Laatste keer limiet geraakt: {datumTijd(verbruik.laatsteLimiet.wanneer)} — {verbruik.laatsteLimiet.melding}
          </p>
        )}
        <p className="mt-1 text-xs text-neutral-500">
          Is de daggrens bereikt, dan wachten nieuwe opdrachten tot morgen. De limieten van het Claude-abonnement
          zelf zijn hier niet zichtbaar.
        </p>
      </section>

      <LeerlusBlok status={leerlus} />
    </div>
  );
}
