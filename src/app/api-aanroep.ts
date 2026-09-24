/**
 * Eén manier om vanuit de UI een API-route aan te roepen die nooit gooit.
 *
 * Waarom: bijna elke knop deed `const json = await res.json()` zonder
 * try/catch. Bij een verlopen sessie, een netwerkfout of een antwoord dat
 * geen JSON is gooit die regel, `setBusy(false)` wordt nooit bereikt en de
 * knop blijft eeuwig op "Bezig…" staan. Hier komt altijd een {ok, json}
 * terug, met een leesbare `fout` als het misging.
 */
export type ApiAntwoord<T = Record<string, unknown>> = {
  ok: boolean;
  status: number;
  json: T & { error?: string };
  /** Leesbare foutmelding als ok=false (uit json.error, of een algemene). */
  fout: string | null;
};

export async function roepApiAan<T = Record<string, unknown>>(
  url: string,
  init?: Omit<RequestInit, 'body'> & { body?: unknown },
): Promise<ApiAntwoord<T>> {
  try {
    const body = init?.body;
    const res = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const json = ((await res.json().catch(() => ({}))) ?? {}) as T & { error?: string };
    const fout = res.ok
      ? null
      : json.error ??
        (res.status === 401 ? 'Je sessie is verlopen — log opnieuw in.' : `Mislukt (${res.status})`);
    return { ok: res.ok, status: res.status, json, fout };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      json: {} as T & { error?: string },
      fout: `Geen verbinding met de server: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
