import { db } from './supabase';
import { importeerCampagneTekst } from './campagne-import';

/**
 * Haalt nieuwe ClipArmy-campagnes op in de cloud, met een sessiecookie die jij
 * zelf plakt (Instellingen -> ClipArmy-sessie) en zelf kunt intrekken.
 *
 * Waarom een cookie en geen wachtwoord: een opgeslagen wachtwoord geeft
 * volledige toegang tot je account en kan wachtwoordwijzigingen of aankopen
 * doen. Een sessiecookie is beperkt, verloopt vanzelf en trek je in door
 * ergens uit te loggen. De tool leest alleen de campagnepagina die jij ook
 * ziet, één keer per uur — geen scraping op schaal.
 */
export async function haalClipArmyCampagnes(): Promise<{
  nieuw: { naam: string; id: string }[];
  bekeken: number;
  fout?: string;
}> {
  const supabase = db();
  const { data: sessie } = await supabase
    .from('platform_sessies')
    .select('cookie')
    .eq('platform', 'cliparmy')
    .maybeSingle();

  if (!sessie?.cookie) {
    return { nieuw: [], bekeken: 0, fout: 'Geen ClipArmy-sessie ingesteld.' };
  }

  const res = await fetch('https://cliparmy.nl/campaigns', {
    headers: {
      cookie: sessie.cookie as string,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const fout = `ClipArmy gaf ${res.status}${res.status === 401 || res.status === 403 ? ' — sessie verlopen, plak een nieuwe' : ''}`;
    await supabase
      .from('platform_sessies')
      .update({ laatste_check: new Date().toISOString(), laatste_fout: fout })
      .eq('platform', 'cliparmy');
    return { nieuw: [], bekeken: 0, fout };
  }

  const html = await res.text();
  const tekst = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Ingelogd? Dan staan er campagnenamen; anders krijgen we de loginpagina.
  if (/log in om|inloggen|wachtwoord vergeten/i.test(tekst.slice(0, 600))) {
    const fout = 'Niet ingelogd: de sessie is verlopen. Plak een verse cookie.';
    await supabase
      .from('platform_sessies')
      .update({ laatste_check: new Date().toISOString(), laatste_fout: fout })
      .eq('platform', 'cliparmy');
    return { nieuw: [], bekeken: 0, fout };
  }

  // Welke campagnes kennen we al? Vergelijken op naam is genoeg en voorkomt
  // dubbele imports als de pagina anders opgebouwd wordt.
  const { data: bestaand } = await supabase.from('campaigns').select('name');
  const bekend = new Set((bestaand ?? []).map((c) => normaliseer(c.name as string)));

  const blokken = splitsCampagnes(tekst);
  const nieuw: { naam: string; id: string }[] = [];

  for (const blok of blokken) {
    const naam = normaliseer(blok.slice(0, 80));
    if (!naam || [...bekend].some((b) => b.includes(naam.slice(0, 20)) || naam.includes(b.slice(0, 20)))) continue;
    if (blok.length < 120) continue;

    const r = await importeerCampagneTekst(blok);
    nieuw.push({ naam: r.campaign.name as string, id: r.campaign.id as string });
    bekend.add(normaliseer(r.campaign.name as string));
  }

  await supabase
    .from('platform_sessies')
    .update({ laatste_check: new Date().toISOString(), laatste_fout: null })
    .eq('platform', 'cliparmy');

  return { nieuw, bekeken: blokken.length };
}

/**
 * Knipt de paginatekst in losse campagnes. De pagina is één lange tekst, dus
 * we splitsen op de bedragen/CPM-aanduidingen die elke campagne heeft.
 */
function splitsCampagnes(tekst: string): string[] {
  const delen = tekst.split(/(?=(?:CPM|€\s?\d|Beloning|Budget)\b)/i);
  const blokken: string[] = [];
  let huidig = '';
  for (const deel of delen) {
    huidig += deel;
    if (huidig.length > 400) {
      blokken.push(huidig.slice(0, 4000));
      huidig = '';
    }
  }
  if (huidig.length > 200) blokken.push(huidig.slice(0, 4000));
  return blokken.slice(0, 10);
}

function normaliseer(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
