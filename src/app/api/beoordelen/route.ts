import { NextRequest, NextResponse } from 'next/server';
import { r2SignedUrl } from '@/lib/r2';
import { beoordeelWachtrij } from '@/lib/tracking/leerlus';

export const dynamic = 'force-dynamic';

/** Afspeellinks blijven een uur geldig, lang genoeg voor een beoordeelsessie. */
const LINK_GELDIG_SECONDEN = 3600;

/**
 * De beoordeel-wachtrij: klare renders zonder oordeel, nieuwste eerst, met een
 * verse afspeellink per bestand. `?hookvarianten=1` neemt ook hook2/hook3 mee;
 * `?alleen_aantal=1` geeft alleen het aantal (voor de navigatie).
 */
export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const hookvarianten = params.get('hookvarianten') === '1';
  const ouder = params.get('ouder') === '1';
  try {
    if (params.get('alleen_aantal') === '1') {
      const { totaal } = await beoordeelWachtrij({ hookvarianten, ouder, limiet: 0 });
      return NextResponse.json({ totaal });
    }
    const { items, totaal } = await beoordeelWachtrij({ hookvarianten, ouder, limiet: 60 });
    const metUrl = await Promise.all(
      items.map(async ({ pad, ...rest }) => ({ ...rest, url: await r2SignedUrl(pad, LINK_GELDIG_SECONDEN) })),
    );
    return NextResponse.json({ items: metUrl, totaal });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
