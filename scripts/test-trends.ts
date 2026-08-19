/**
 * Tests voor het pure deel van de trends-agent: de aggregatie van
 * gedecodeerde scout-vondsten naar hook/structuur-rankings. Geen database,
 * geen model — zelfde patroon als de andere poort-tests.
 *
 * Draaien: npm run test:trends
 */
import { aggregeerVondsten, type TrendVondst } from '../src/lib/agents/trends';

let gefaald = 0;
let gedaan = 0;

function toets(naam: string, voorwaarde: boolean, detail = '') {
  gedaan++;
  if (voorwaarde) console.log(`  ✓ ${naam}`);
  else {
    gefaald++;
    console.log(`  ✗ ${naam}${detail ? ` — ${detail}` : ''}`);
  }
}

const vondst = (over: Partial<TrendVondst> & { hook?: string; structuur?: string }): TrendVondst => ({
  post_url: over.post_url ?? `https://x/${Math.abs(JSON.stringify(over).length * 7919) % 100000}${over.handle}`,
  handle: over.handle ?? 'a',
  platform: over.platform ?? 'tiktok',
  theme: over.theme ?? null,
  views_per_dag: over.views_per_dag ?? null,
  decoded:
    over.hook || over.structuur
      ? {
          hook_type: over.hook,
          structuur: over.structuur,
          waarom_het_werkt: 'test',
          overdraagbaar_naar_ons: true,
        }
      : null,
});

console.log('aggregeerVondsten');
{
  // Meer accounts wint van meer posts van één account.
  const finds = [
    vondst({ handle: 'a', hook: 'vraag', post_url: 'u1' }),
    vondst({ handle: 'a', hook: 'vraag', post_url: 'u2' }),
    vondst({ handle: 'a', hook: 'vraag', post_url: 'u3' }),
    vondst({ handle: 'b', hook: 'cijfer', post_url: 'u4' }),
    vondst({ handle: 'c', hook: 'cijfer', post_url: 'u5' }),
  ];
  const r = aggregeerVondsten(finds, 30);
  toets('patroon over meer accounts staat bovenaan', r.hooks[0]?.sleutel === 'cijfer', JSON.stringify(r.hooks.map((h) => h.sleutel)));
  toets('aantal en accounts kloppen', r.hooks[0]?.aantal === 2 && r.hooks[0]?.accounts === 2);
  toets('één account met drie posts telt als één account', r.hooks[1]?.accounts === 1 && r.hooks[1]?.aantal === 3);
}
{
  // Vondsten zonder decodering tellen niet mee; hook en structuur los geteld.
  const finds = [
    vondst({ handle: 'a', hook: 'vraag', structuur: 'lijstje', post_url: 'u1' }),
    vondst({ handle: 'b', post_url: 'u2' }), // ongedecodeerd
    vondst({ handle: 'c', structuur: 'lijstje', post_url: 'u3' }),
  ];
  const r = aggregeerVondsten(finds, 30);
  toets('ongedecodeerde vondst telt niet mee', r.vondsten === 2);
  toets('structuur apart geteld', r.structuren[0]?.sleutel === 'lijstje' && r.structuren[0]?.aantal === 2);
}
{
  // Mediaan views-per-dag en topvoorbeelden op volgorde van views.
  const finds = [
    vondst({ handle: 'a', hook: 'vraag', views_per_dag: 100, post_url: 'u1' }),
    vondst({ handle: 'b', hook: 'vraag', views_per_dag: 900, post_url: 'u2' }),
    vondst({ handle: 'c', hook: 'vraag', views_per_dag: 500, post_url: 'u3' }),
  ];
  const r = aggregeerVondsten(finds, 30);
  toets('mediaan views/dag klopt', r.hooks[0]?.mediaanViewsPerDag === 500, String(r.hooks[0]?.mediaanViewsPerDag));
  toets('sterkste voorbeeld eerst', r.hooks[0]?.voorbeelden[0]?.post_url === 'u2');
}
{
  // Platform- en themaverdeling per patroon.
  const finds = [
    vondst({ handle: 'a', hook: 'vraag', platform: 'tiktok', theme: 'comedy', post_url: 'u1' }),
    vondst({ handle: 'b', hook: 'vraag', platform: 'shorts', theme: 'comedy', post_url: 'u2' }),
  ];
  const r = aggregeerVondsten(finds, 30);
  toets('platformverdeling klopt', r.hooks[0]?.platforms.tiktok === 1 && r.hooks[0]?.platforms.shorts === 1);
  toets('themaverdeling klopt', r.hooks[0]?.themas.comedy === 2);
}
{
  toets('lege invoer geeft lege rankings', aggregeerVondsten([], 30).hooks.length === 0);
}

console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
process.exit(gefaald === 0 ? 0 : 1);
