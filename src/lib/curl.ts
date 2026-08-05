/**
 * Leest een uit de browser gekopieerd cURL-commando ("Copy as cURL") uit.
 *
 * Waarom niet gewoon een cookie: een moderne webapp haalt zijn data niet uit de
 * HTML maar uit een API-call met een token in de headers. Welke call dat is en
 * welke headers hij nodig heeft, verschilt per site en verandert zonder
 * aankondiging. Door het hele verzoek over te nemen zoals de browser het
 * verstuurt, hoeven wij dat niet te raden.
 */
export type Verzoek = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

export function parseCurl(commando: string): Verzoek {
  // Regelvervolgingen (\ aan het eind, of ^ op Windows) weghalen.
  const tekst = commando.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ').trim();

  const tokens = splitsTokens(tekst);
  if (tokens[0] !== 'curl') throw new Error('Dit lijkt geen cURL-commando. Kies in DevTools "Copy as cURL".');

  const verzoek: Verzoek = { url: '', method: 'GET', headers: {} };
  let methodExpliciet = false;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-H' || t === '--header') {
      const [k, ...rest] = tokens[++i].split(':');
      const waarde = rest.join(':').trim();
      // Pseudo-headers (:authority) en accept-encoding laten we weg: die zet
      // fetch zelf en fout ingevulde encoding levert onleesbare bytes op.
      if (k && !k.startsWith(':') && k.toLowerCase() !== 'accept-encoding') {
        verzoek.headers[k.trim().toLowerCase()] = waarde;
      }
    } else if (t === '-b' || t === '--cookie') {
      verzoek.headers.cookie = tokens[++i];
    } else if (t === '-X' || t === '--request') {
      verzoek.method = tokens[++i].toUpperCase();
      methodExpliciet = true;
    } else if (t === '--data' || t === '-d' || t === '--data-raw' || t === '--data-binary') {
      verzoek.body = tokens[++i];
      if (!methodExpliciet) verzoek.method = 'POST';
    } else if (t === '--url') {
      verzoek.url = tokens[++i];
    } else if (!t.startsWith('-') && !verzoek.url) {
      verzoek.url = t;
    }
  }

  if (!/^https?:\/\//i.test(verzoek.url)) throw new Error('Geen geldige URL in het cURL-commando gevonden.');
  return verzoek;
}

/** Splitst op spaties, maar respecteert enkele en dubbele aanhalingstekens. */
function splitsTokens(tekst: string): string[] {
  const uit: string[] = [];
  let huidig = '';
  let quote: '"' | "'" | null = null;
  let bezig = false;

  for (let i = 0; i < tekst.length; i++) {
    const c = tekst[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < tekst.length) {
        huidig += tekst[++i];
      } else if (c === quote) {
        quote = null;
      } else {
        huidig += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      bezig = true;
    } else if (/\s/.test(c)) {
      if (bezig || huidig) uit.push(huidig);
      huidig = '';
      bezig = false;
    } else {
      huidig += c;
      bezig = true;
    }
  }
  if (bezig || huidig) uit.push(huidig);
  return uit;
}

/**
 * Haalt de gevoelige waarden eruit voor weergave, zodat we in het dashboard wel
 * kunnen laten zien wélk verzoek er staat zonder het token te tonen.
 */
export function beschrijfVerzoek(v: Verzoek): string {
  const u = new URL(v.url);
  return `${v.method} ${u.host}${u.pathname}`;
}
