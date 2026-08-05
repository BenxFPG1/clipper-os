import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

const CORS = {
  'Access-Control-Allow-Origin': 'https://cliparmy.nl',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-clipper-sleutel',
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * Koppelt het automatisch ophalen met één klik vanaf de campagnepagina.
 *
 * Waarom dit naast het plakken van een cURL bestaat: een toegangstoken leeft
 * ongeveer een uur, dus een geplakt token is al verlopen tegen de tijd dat de
 * uurlijkse cron draait. Het vernieuwingstoken staat alleen in de opslag van je
 * browser en komt in geen enkel netwerkverzoek voor — dat kun je dus niet
 * kopiëren, alleen vanaf de pagina zelf uitlezen. Daar is de bladwijzer voor.
 *
 * Wat er bewaard wordt is precies wat de site zelf ook gebruikt om ingelogd te
 * blijven. Je trekt het in door op ClipArmy uit te loggen.
 */
export async function POST(req: NextRequest) {
  const sleutel = req.headers.get('x-clipper-sleutel');
  if (!process.env.APP_PASSWORD || sleutel !== process.env.APP_PASSWORD) {
    return NextResponse.json({ error: 'Ongeldige sleutel' }, { status: 401, headers: CORS });
  }

  const body = (await req.json().catch(() => ({}))) as {
    projectUrl?: string;
    apikey?: string;
    access_token?: string;
    refresh_token?: string;
    url?: string;
  };

  const ontbreekt = (['projectUrl', 'apikey', 'access_token', 'refresh_token'] as const).filter(
    (k) => !body[k],
  );
  if (ontbreekt.length) {
    return NextResponse.json(
      { error: `Niet gevonden op de pagina: ${ontbreekt.join(', ')}. Ben je ingelogd?` },
      { status: 400, headers: CORS },
    );
  }

  const supabase = db();

  // Staat er al een verzoek van een geplakte cURL? Dan houden we die url en
  // headers aan — daar staat de exacte campagne-query in — en vullen we alleen
  // de tokens aan.
  const { data: bestaand } = await supabase
    .from('platform_sessies')
    .select('verzoek')
    .eq('platform', 'cliparmy')
    .maybeSingle();

  const oud = bestaand?.verzoek as { url?: string; headers?: Record<string, string> } | null;
  const url = oud?.url ?? body.url ?? `${body.projectUrl}/rest/v1/v_my_campaigns?select=*`;

  const verzoek = {
    url,
    method: 'GET',
    headers: {
      ...(oud?.headers ?? {}),
      apikey: body.apikey as string,
      authorization: `Bearer ${body.access_token}`,
      accept: 'application/json',
    },
    auth: {
      projectUrl: body.projectUrl as string,
      apikey: body.apikey as string,
      refresh_token: body.refresh_token as string,
    },
  };

  const { error } = await supabase
    .from('platform_sessies')
    .upsert(
      { platform: 'cliparmy', verzoek, cookie: null, laatste_fout: null, laatste_check: null },
      { onConflict: 'platform' },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS });

  return NextResponse.json({ ok: true, url }, { headers: CORS });
}
