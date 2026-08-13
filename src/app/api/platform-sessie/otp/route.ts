import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

/**
 * Koppelen via een e-mailcode: ClipArmy stuurt jou een inlogcode, jij tikt hem
 * hier in, en Clipper OS krijgt daarmee een éígen sessie.
 *
 * Waarom deze route bestaat: log je bij ClipArmy in met Google, dan heeft je
 * account geen wachtwoord, en een token uit je browser overnemen botst met je
 * eigen sessie (beide vernieuwen hetzelfde token en loggen elkaar uit). De
 * e-mailcode maakt een lósse sessie aan die alleen van de cloud is: die
 * vernieuwt zichzelf elk uur en raakt jouw browser niet.
 *
 * Er wordt geen wachtwoord bewaard en de code werkt maar één keer; intrekken
 * kan altijd door bij ClipArmy overal uit te loggen.
 */

function basisVanSessie(verzoek: unknown): { project: string; apikey: string } | null {
  const v = verzoek as {
    url?: string;
    headers?: Record<string, string>;
    auth?: { projectUrl?: string; apikey?: string };
  } | null;
  const project = v?.auth?.projectUrl ?? (v?.url ? new URL(v.url).origin : null);
  const apikey = v?.auth?.apikey ?? v?.headers?.apikey;
  return project && apikey ? { project, apikey } : null;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    actie?: 'start' | 'verify';
    email?: string;
    code?: string;
  };

  const supabase = db();
  const { data: sessie } = await supabase
    .from('platform_sessies')
    .select('verzoek')
    .eq('platform', 'cliparmy')
    .maybeSingle();

  const basis = basisVanSessie(sessie?.verzoek);
  if (!basis) {
    return NextResponse.json(
      {
        error:
          'Eerst eenmalig het cURL-verzoek plakken (stap hieronder): daar halen we het adres en de publieke sleutel van ClipArmy uit.',
      },
      { status: 400 },
    );
  }

  if (!body.email?.includes('@')) {
    return NextResponse.json({ error: 'Vul het e-mailadres van je ClipArmy-account in.' }, { status: 400 });
  }

  if (body.actie === 'start') {
    const res = await fetch(`${basis.project}/auth/v1/otp`, {
      method: 'POST',
      headers: { apikey: basis.apikey, 'content-type': 'application/json' },
      body: JSON.stringify({ email: body.email, create_user: false }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 140);
      return NextResponse.json(
        { error: `ClipArmy weigerde de code (${res.status}): ${detail}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (body.actie === 'verify') {
    if (!body.code?.trim()) {
      return NextResponse.json({ error: 'Vul de code of de inloglink uit de e-mail in.' }, { status: 400 });
    }

    // De mail bevat afhankelijk van ClipArmy's sjabloon een cijfercode of een
    // inloglink. Allebei goed: uit een geplakte link vissen we de token_hash en
    // verzilveren die — dan logt de link de cloud in, in plaats van je browser.
    const invoer = body.code.trim();
    let verifyBody: Record<string, string>;
    const alsUrl = (() => {
      try {
        return new URL(invoer);
      } catch {
        return null;
      }
    })();
    const hash = alsUrl?.searchParams.get('token_hash') ?? alsUrl?.searchParams.get('token');
    if (hash) {
      verifyBody = { type: alsUrl?.searchParams.get('type') ?? 'magiclink', token_hash: hash };
    } else if (/^pkce_|^[0-9a-f]{20,}$/i.test(invoer)) {
      verifyBody = { type: 'magiclink', token_hash: invoer };
    } else {
      verifyBody = { type: 'email', email: body.email as string, token: invoer };
    }

    const res = await fetch(`${basis.project}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: basis.apikey, 'content-type': 'application/json' },
      body: JSON.stringify(verifyBody),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 140);
      return NextResponse.json(
        { error: `Code niet geaccepteerd (${res.status}): ${detail}` },
        { status: 502 },
      );
    }

    const tokens = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (!tokens.access_token || !tokens.refresh_token) {
      return NextResponse.json({ error: 'Antwoord zonder tokens; probeer een nieuwe code.' }, { status: 502 });
    }

    // De bestaande campagne-query aanhouden en alleen de sessie vervangen —
    // behalve als die query op één campagne-ID is vastgezet (id=in.(...)).
    // Dat gebeurt als de allereerste cURL per ongeluk vanaf een
    // campagnedetail-pagina gekopieerd is in plaats van het overzicht; zo'n
    // query vindt dan voor altijd hooguit die ene (allang geïmporteerde)
    // campagne en nooit iets nieuws. In dat geval terugvallen op de brede
    // lijst-query in plaats van de kapotte query eindeloos te herhalen.
    const oud = sessie?.verzoek as { url?: string; headers?: Record<string, string> } | null;
    const oudeUrlVastOpEenId = oud?.url ? /[?&]id=in\.\(/.test(oud.url) : false;
    const verzoek = {
      url: !oudeUrlVastOpEenId && oud?.url ? oud.url : `${basis.project}/rest/v1/v_my_campaigns?select=*`,
      method: 'GET',
      headers: {
        ...(oud?.headers ?? {}),
        apikey: basis.apikey,
        authorization: `Bearer ${tokens.access_token}`,
        accept: 'application/json',
      },
      auth: { projectUrl: basis.project, apikey: basis.apikey, refresh_token: tokens.refresh_token },
    };

    const { error } = await supabase
      .from('platform_sessies')
      .upsert(
        { platform: 'cliparmy', verzoek, cookie: null, laatste_fout: null, laatste_check: null },
        { onConflict: 'platform' },
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Onbekende actie.' }, { status: 400 });
}
