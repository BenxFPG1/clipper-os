import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { optionalEnv, requireEnv } from './env';

/**
 * Cloudflare R2: S3-compatibele opslag voor gerenderde clips, muziekbedden en
 * transcriptiecache. Vervangt Supabase Storage — die gaf maar 1GB gratis,
 * veel te weinig voor een tool die voortdurend video rendert (de opslag zat
 * binnen twee weken vol met niets dan een backlog onbeoordeelde clips). R2
 * geeft 10GB gratis én rekent geen dataverkeer — bij video's loopt dat bij
 * Supabase juist het snelst op.
 *
 * De functiesignaturen volgen bewust de vorm van de oude
 * supabase.storage.from(BUCKET)-calls ({data, error} met .arrayBuffer()/
 * .text()) zodat de call-sites een kleine, voorspelbare wijziging kregen in
 * plaats van een herschrijving.
 */

let cached: S3Client | null = null;

function client(): S3Client {
  if (!cached) {
    cached = new S3Client({
      region: 'auto',
      endpoint: `https://${requireEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
        secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
      },
      // Nieuwere AWS-SDK-versies rekenen standaard een checksum uit en zetten
      // die als extra header mee in de handtekening; R2 valideert dat anders
      // dan S3 zelf en gaf daardoor 403 SignatureDoesNotMatch op elke signed
      // URL. WHEN_REQUIRED zet dat gedrag terug naar het oude, R2-compatibele
      // pad.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return cached;
}

export function r2Bucket(): string {
  return optionalEnv('R2_BUCKET', 'clipper-os-montages');
}

export async function r2Upload(
  pad: string,
  data: Buffer | Uint8Array,
  contentType: string,
): Promise<{ error: Error | null }> {
  try {
    await client().send(
      new PutObjectCommand({ Bucket: r2Bucket(), Key: pad, Body: data, ContentType: contentType }),
    );
    return { error: null };
  } catch (e) {
    return { error: e as Error };
  }
}

async function streamNaarBuffer(stream: Readable): Promise<Buffer> {
  const stukken: Buffer[] = [];
  for await (const stuk of stream) stukken.push(Buffer.isBuffer(stuk) ? stuk : Buffer.from(stuk));
  return Buffer.concat(stukken);
}

export async function r2Download(
  pad: string,
): Promise<{
  data: { arrayBuffer: () => Promise<ArrayBuffer>; text: () => Promise<string> } | null;
  error: Error | null;
}> {
  try {
    const res = await client().send(new GetObjectCommand({ Bucket: r2Bucket(), Key: pad }));
    const buffer = await streamNaarBuffer(res.Body as Readable);
    return {
      data: {
        arrayBuffer: async () => Uint8Array.from(buffer).buffer,
        text: async () => buffer.toString('utf-8'),
      },
      error: null,
    };
  } catch (e) {
    // Ontbrekend bestand (NoSuchKey) is voor de meeste aanroepers gewoon een
    // "nog niet gecachet"-signaal, geen storing — vandaar geen throw.
    return { data: null, error: e as Error };
  }
}

/** Tijdelijke downloadlink; de bucket staat privé, dus dit is de enige manier om de browser er toegang toe te geven. */
export async function r2SignedUrl(pad: string, verlooptNaSeconden: number): Promise<string | null> {
  try {
    return await getSignedUrl(client(), new GetObjectCommand({ Bucket: r2Bucket(), Key: pad }), {
      expiresIn: verlooptNaSeconden,
    });
  } catch {
    return null;
  }
}
