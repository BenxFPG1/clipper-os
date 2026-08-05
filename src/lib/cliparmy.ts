import { db } from './supabase';
import { importeerCampagneTekst } from './campagne-import';
import type { Verzoek } from './curl';

/**
 * Haalt nieuwe ClipArmy-campagnes op in de cloud door het verzoek te herhalen
 * dat jouw eigen browser doet — url, headers en token, één keer geplakt via
 * "Copy as cURL" (Instellingen -> ClipArmy automatisch ophalen).
 *
 * Waarom het hele verzoek en niet alleen een cookie: ClipArmy is een SPA. De
 * campagnes staan niet in de HTML maar komen uit een API-call met een token in
 * de headers; een losse cookie levert dus een lege pagina op.
 *
 * Waarom geen wachtwoord: een opgeslagen wachtwoord geeft volledige toegang tot
 * je account. Een sessietoken leest alleen wat jij zelf ook ziet, verloopt
 * vanzelf, en je trekt hem in door op ClipArmy uit te loggen.
 */
export async function haalClipArmyCampagnes(): Promise<{
  nieuw: { naam: string; id: string }[];
  bekeken: number;
  fout?: string;
}> {
  const supabase = db();
  const { data: sessie } = await supabase
    .from('platform_sessies')
    .select('verzoek, cookie')
    .eq('platform', 'cliparmy')
    .maybeSingle();

  const verzoek = (sessie?.verzoek as Verzoek | null) ?? maakVerzoekVanCookie(sessie?.cookie as string | null);
  if (!verzoek) {
    return { nieuw: [], bekeken: 0, fout: 'Geen ClipArmy-sessie ingesteld.' };
  }

  let res: Response;
  try {
    res = await fetch(verzoek.url, {
      method: verzoek.method,
      headers: verzoek.headers,
      body: verzoek.body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { nieuw: [], bekeken: 0, fout: await noteer(`Verzoek mislukt: ${(e as Error).message}`) };
  }

  if (!res.ok) {
    const verlopen = res.status === 401 || res.status === 403;
    return {
      nieuw: [],
      bekeken: 0,
      fout: await noteer(`ClipArmy gaf ${res.status}${verlopen ? ' — token verlopen, plak een vers verzoek' : ''}`),
    };
  }

  const ruw = await res.text();
  const blokken = res.headers.get('content-type')?.includes('json')
    ? blokkenUitJson(ruw)
    : blokkenUitHtml(ruw);

  if (blokken.length === 0) {
    return { nieuw: [], bekeken: 0, fout: await noteer('Antwoord bevatte geen herkenbare campagnes.') };
  }

  // Welke campagnes kennen we al? Vergelijken op naam is genoeg en voorkomt
  // dubbele imports als het antwoord anders opgebouwd wordt.
  const { data: bestaand } = await supabase.from('campaigns').select('name');
  const bekend = new Set((bestaand ?? []).map((c) => normaliseer(c.name as string)));

  const nieuw: { naam: string; id: string }[] = [];
  for (const blok of blokken) {
    const naam = normaliseer(blok.slice(0, 80));
    if (!naam || blok.length < 120) continue;
    if ([...bekend].some((b) => b.includes(naam.slice(0, 20)) || naam.includes(b.slice(0, 20)))) continue;

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

/** Oude opzet: alleen een cookie bewaard. Blijft werken voor pure HTML-pagina's. */
function maakVerzoekVanCookie(cookie: string | null): Verzoek | null {
  if (!cookie) return null;
  return {
    url: 'https://cliparmy.nl/campaigns',
    method: 'GET',
    headers: {
      cookie,
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
  };
}

/**
 * Een API-antwoord is een lijst objecten: elke campagne wordt één tekstblok dat
 * de import-agent net zo leest als een geplakte briefing. We geven de veldnamen
 * mee, want die dragen betekenis ("deadline", "cpm", "platform").
 */
function blokkenUitJson(ruw: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(ruw);
  } catch {
    return [];
  }

  const rijen = Array.isArray(data)
    ? data
    : Array.isArray((data as { data?: unknown[] })?.data)
      ? (data as { data: unknown[] }).data
      : Array.isArray((data as { campaigns?: unknown[] })?.campaigns)
        ? (data as { campaigns: unknown[] }).campaigns
        : [];

  return rijen
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
    .slice(0, 25)
    .map((rij) =>
      Object.entries(rij)
        .filter(([, v]) => v !== null && v !== '' && typeof v !== 'object')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
        .slice(0, 4000),
    );
}

/**
 * Knipt de paginatekst in losse campagnes. De pagina is één lange tekst, dus
 * we splitsen op de bedragen/CPM-aanduidingen die elke campagne heeft.
 */
function blokkenUitHtml(html: string): string[] {
  const tekst = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/log in om|inloggen|wachtwoord vergeten/i.test(tekst.slice(0, 600))) return [];

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

/** Zet de fout bij de sessie zodat je in het dashboard ziet wat er misging. */
async function noteer(fout: string): Promise<string> {
  await db()
    .from('platform_sessies')
    .update({ laatste_check: new Date().toISOString(), laatste_fout: fout })
    .eq('platform', 'cliparmy');
  return fout;
}

function normaliseer(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
