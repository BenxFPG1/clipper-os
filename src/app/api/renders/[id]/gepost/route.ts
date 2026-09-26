import { NextRequest, NextResponse } from 'next/server';
import { LeerlusFout, markeerGepost } from '@/lib/tracking/leerlus';

/**
 * "Gepost": koppelt een post-URL aan één gerenderd bestand. Maakt of werkt de
 * clip-rij bij (status posted, platform uit de link); vanaf dan meet de
 * tracking hem vanzelf en weet de retro uit welke render en hookvariant hij
 * komt.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as { bestand_naam?: string; post_url?: string };
  if (!body.bestand_naam) return NextResponse.json({ error: 'bestand_naam is verplicht' }, { status: 400 });
  if (!body.post_url?.trim()) return NextResponse.json({ error: 'Plak de link van de post' }, { status: 400 });

  try {
    const clip = await markeerGepost({ renderJobId: params.id, bestandNaam: body.bestand_naam, postUrl: body.post_url });
    return NextResponse.json({ clip });
  } catch (e) {
    const status = e instanceof LeerlusFout ? e.status : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
