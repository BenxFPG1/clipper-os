import { r2Download, r2SignedUrl, r2Upload } from '../r2';

/**
 * De status van een afwerkpakket, tabel-loos in R2 naast de zip:
 * afwerk/<renderJobId>/<clip>.json en afwerk/<renderJobId>/<clip>.zip.
 *
 * Waarom geen tabel: er is maar één toestand per (render, bestand), de zip
 * zelf staat toch al in R2, en zo hoeft er geen migratie te draaien voordat
 * de knop werkt. De site zet 'wachtend' en start de workflow; de workflow
 * (scripts/afwerkpakket.ts --wachtrij) pakt alles op wat wacht.
 *
 * Bewust zonder ffmpeg, canvas of yt-dlp: dit bestand draait ook op Vercel.
 */

export type AfwerkStatus = {
  status: 'wachtend' | 'bezig' | 'klaar' | 'mislukt';
  render_job_id: string;
  bestand_naam: string;
  aangevraagd_at: string;
  bijgewerkt_at: string;
  voortgang?: string;
  fout?: string;
  /** Wat de editor moet weten (bron in lagere kwaliteit, ontbrekende muziek…). */
  meldingen?: string[];
  zip?: string;
  bytes?: number;
};

/** Een run die zo lang niets meer schreef is afgebroken (runner weg, time-out). */
export const AFWERK_VERLOPEN_MS = 45 * 60_000;

/** Basisnaam van een bestand zonder extensie: 03-titel.mp4 → 03-titel. */
export function afwerkBasis(bestandNaam: string): string {
  return bestandNaam.replace(/\.[a-z0-9]+$/i, '').replace(/[/\\]/g, '-');
}

export const afwerkSleutel = (renderJobId: string, bestandNaam: string, ext: 'json' | 'zip') =>
  `afwerk/${renderJobId}/${afwerkBasis(bestandNaam)}.${ext}`;

export async function leesAfwerkStatus(renderJobId: string, bestandNaam: string): Promise<AfwerkStatus | null> {
  const { data } = await r2Download(afwerkSleutel(renderJobId, bestandNaam, 'json'));
  if (!data) return null;
  try {
    return JSON.parse(await data.text()) as AfwerkStatus;
  } catch {
    return null;
  }
}

export async function schrijfAfwerkStatus(s: AfwerkStatus): Promise<void> {
  const { error } = await r2Upload(
    afwerkSleutel(s.render_job_id, s.bestand_naam, 'json'),
    Buffer.from(JSON.stringify({ ...s, bijgewerkt_at: new Date().toISOString() }, null, 1)),
    'application/json',
  );
  if (error) throw error;
}

/**
 * Hoe de site de status toont: een 'bezig' of 'wachtend' die al lang niets
 * meer schreef is in werkelijkheid mislukt (een run die halverwege stierf
 * laat anders eeuwig "pakket wordt gemaakt…" staan).
 */
export function effectieveStatus(s: AfwerkStatus, nu = Date.now()): AfwerkStatus {
  if ((s.status === 'bezig' || s.status === 'wachtend') && nu - Date.parse(s.bijgewerkt_at) > AFWERK_VERLOPEN_MS) {
    return {
      ...s,
      status: 'mislukt',
      fout:
        s.status === 'bezig'
          ? 'De cloudrun is halverwege gestopt. Vraag het pakket opnieuw aan.'
          : 'Niet opgepakt door de cloud (is de workflow afwerkpakket.yml actief?). Vraag het opnieuw aan.',
    };
  }
  return s;
}

/** Downloadlink voor de zip: 7 dagen, het maximum van een R2-presigned URL. */
export async function afwerkDownloadUrl(s: AfwerkStatus): Promise<string | null> {
  if (s.status !== 'klaar' || !s.zip) return null;
  return r2SignedUrl(s.zip, 7 * 24 * 3600);
}
