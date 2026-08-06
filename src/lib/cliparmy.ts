import { db } from './supabase';
import { importeerCampagneTekst } from './campagne-import';
import type { Verzoek } from './curl';

/** Wat er nodig is om zelf een vers toegangstoken te halen. */
type Vernieuwing = { projectUrl: string; apikey: string; refresh_token: string };

/**
 * Inloggen met je eigen accountgegevens uit de omgevingsvariabelen.
 *
 * Dit is de enige manier die blijvend werkt zonder handwerk: een token uit de
 * browser leeft een uur en botst bovendien met je eigen sessie zodra jij de
 * site ook opent. Met inloggen begint elke run met een vers token.
 *
 * Bewust uit env en niet uit de database: het wachtwoord staat dan alleen in je
 * .env en in je GitHub-secrets, nergens in data die we rondsturen of loggen.
 * Er wordt precies één ding mee gedaan — inloggen om de campagnelijst te lezen
 * die jij zelf ook ziet.
 */
async function logIn(projectUrl: string, apikey: string): Promise<string | null> {
  const email = process.env.CLIPARMY_EMAIL;
  const wachtwoord = process.env.CLIPARMY_WACHTWOORD;
  if (!email || !wachtwoord) return null;

  const res = await fetch(`${projectUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: wachtwoord }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 120);
    throw new Error(
      res.status === 400
        ? `inloggen met wachtwoord geweigerd (${detail}). Log je in met Google, dan heeft je account geen wachtwoord — zet er via "wachtwoord vergeten" op cliparmy.nl een op, of gebruik de koppeling met de bladwijzer.`
        : `inloggen gaf ${res.status}: ${detail}`,
    );
  }

  const j = (await res.json()) as { access_token?: string };
  return j.access_token ?? null;
}

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

  const verzoek: (Verzoek & { auth?: Vernieuwing }) | null =
    (sessie?.verzoek as (Verzoek & { auth?: Vernieuwing }) | null) ??
    maakVerzoekVanCookie(sessie?.cookie as string | null);
  if (!verzoek) {
    return { nieuw: [], bekeken: 0, fout: 'Geen ClipArmy-sessie ingesteld.' };
  }

  // Een toegangstoken van dit soort platforms leeft ongeveer een uur. Een
  // uurlijkse cron met een handmatig geplakt token is dus per definitie
  // kansloos: tegen de tijd dat hij draait is het al verlopen. Met het
  // vernieuwingstoken halen we zelf een vers token op, precies zoals de site
  // zelf doet, en bewaren we het nieuwe vernieuwingstoken voor de volgende keer.
  // Eerst proberen in te loggen: dat geeft altijd een vers token en botst niet
  // met je eigen browsersessie. Lukt dat niet (geen gegevens ingesteld), dan
  // valt hij terug op het vernieuwingstoken uit de koppeling.
  const project = verzoek.auth?.projectUrl ?? veiligeOrigin(verzoek.url);
  const sleutel = verzoek.auth?.apikey ?? verzoek.headers.apikey;
  let ingelogd = false;
  let inlogFout: string | null = null;
  if (project && sleutel) {
    try {
      const token = await logIn(project, sleutel);
      if (token) {
        verzoek.headers.authorization = `Bearer ${token}`;
        ingelogd = true;
      }
    } catch (e) {
      // Niet meteen opgeven: log je in met Google, dan bestaat er geen
      // wachtwoord en faalt dit altijd. Het vernieuwingstoken uit de koppeling
      // werkt dan nog wel.
      inlogFout = (e as Error).message;
    }
  }

  if (!ingelogd && verzoek.auth?.refresh_token) {
    try {
      const vers = await vernieuwToken(verzoek.auth);
      verzoek.headers.authorization = `Bearer ${vers.access_token}`;
      await supabase
        .from('platform_sessies')
        .update({
          verzoek: { ...verzoek, auth: { ...verzoek.auth, refresh_token: vers.refresh_token } },
        })
        .eq('platform', 'cliparmy');
    } catch (e) {
      return {
        nieuw: [],
        bekeken: 0,
        fout: await noteer(
          `Token vernieuwen mislukt: ${(e as Error).message.slice(0, 100)}` +
            (inlogFout ? ` (inloggen lukte ook niet: ${inlogFout.slice(0, 80)})` : ''),
        ),
      };
    }
  } else if (!ingelogd && inlogFout) {
    return { nieuw: [], bekeken: 0, fout: await noteer(`ClipArmy: ${inlogFout}`) };
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

/** De basis-URL van het project uit de campagne-URL halen. */
function veiligeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Ruilt het vernieuwingstoken in voor een vers toegangstoken. Dit is hetzelfde
 * verzoek dat de site zelf elk uur doet; wij doen het alleen vanaf de server,
 * waar geen CORS geldt.
 */
async function vernieuwToken(auth: Vernieuwing): Promise<{ access_token: string; refresh_token: string }> {
  const res = await fetch(`${auth.projectUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: auth.apikey, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: auth.refresh_token }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 80)}`);

  const j = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!j.access_token || !j.refresh_token) throw new Error('antwoord zonder tokens');
  return { access_token: j.access_token, refresh_token: j.refresh_token };
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
