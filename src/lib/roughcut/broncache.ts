import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { optionalEnv } from '../env';
import { r2Bucket } from '../r2';
import { instelling } from './instellingen';

/**
 * Bronvideo's cachen in R2 (prefix bron/<videoId>/…).
 *
 * Een tweede render van dezelfde video downloadde alles opnieuw van YouTube:
 * de analysebron (minuten) en de 4K-secties. Per render is dat de grootste
 * vaste kostenpost, en YouTube knijpt bij herhaalde downloads. Nu staat na
 * de eerste render alles in R2 (10 GB gratis, geen dataverkeerkosten), en
 * haalt een volgende render het daar weg — gestreamd, want een analysebron is
 * zo een halve gigabyte en past niet prettig in het geheugen.
 *
 * Opruimen na BRONCACHE_DAGEN (standaard 14) via ruimBronCacheOp, aan het
 * begin van elke worker-run. Alles best-effort: zonder R2 of bij een fout
 * gewoon downloaden zoals voorheen.
 */

let cached: S3Client | null = null;
function client(): S3Client | null {
  const account = optionalEnv('R2_ACCOUNT_ID', '');
  const key = optionalEnv('R2_ACCESS_KEY_ID', '');
  const geheim = optionalEnv('R2_SECRET_ACCESS_KEY', '');
  if (!account || !key || !geheim) return null;
  if (!cached) {
    cached = new S3Client({
      region: 'auto',
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: key, secretAccessKey: geheim },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return cached;
}

export const bronSleutel = (videoId: string, naam: string) => `bron/${videoId}/${naam}`;

/** Haalt een gecachet bestand naar `doel` (via een tijdelijk bestand). True als het er was. */
export async function haalUitBronCache(sleutel: string, doel: string): Promise<boolean> {
  const c = client();
  if (!c) return false;
  const tijdelijk = `${doel}.deel`;
  try {
    const res = await c.send(new GetObjectCommand({ Bucket: r2Bucket(), Key: sleutel }));
    if (!res.Body) return false;
    await pipeline(res.Body as Readable, createWriteStream(tijdelijk));
    await rename(tijdelijk, doel);
    return true;
  } catch {
    await rm(tijdelijk, { force: true });
    return false;
  }
}

/** Zet een bestand in de cache (gestreamd). Stil bij een fout. */
export async function bewaarInBronCache(sleutel: string, pad: string): Promise<boolean> {
  const c = client();
  if (!c || !existsSync(pad)) return false;
  const grootte = statSync(pad).size;
  if (grootte > 4.5e9) return false; // boven de limiet van één PUT
  try {
    await c.send(new PutObjectCommand({ Bucket: r2Bucket(), Key: sleutel, Body: createReadStream(pad), ContentLength: grootte }));
    return true;
  } catch {
    return false;
  }
}

/** Alles onder een prefix (sleutels en grootte). */
export async function lijstBronCache(prefix: string): Promise<{ sleutel: string; bytes: number; gewijzigd: Date }[]> {
  const c = client();
  if (!c) return [];
  const uit: { sleutel: string; bytes: number; gewijzigd: Date }[] = [];
  let token: string | undefined;
  try {
    do {
      const res = await c.send(new ListObjectsV2Command({ Bucket: r2Bucket(), Prefix: prefix, ContinuationToken: token }));
      for (const o of res.Contents ?? []) {
        if (o.Key) uit.push({ sleutel: o.Key, bytes: o.Size ?? 0, gewijzigd: o.LastModified ?? new Date(0) });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  } catch {
    return uit;
  }
  return uit;
}

/** Ruimt gecachete bronnen op die ouder zijn dan BRONCACHE_DAGEN. */
export async function ruimBronCacheOp(): Promise<{ verwijderd: number; mb: number }> {
  const c = client();
  if (!c) return { verwijderd: 0, mb: 0 };
  const grens = Date.now() - instelling('BRONCACHE_DAGEN') * 86_400_000;
  const oud = (await lijstBronCache('bron/')).filter((o) => o.gewijzigd.getTime() < grens);
  let verwijderd = 0;
  let bytes = 0;
  for (let i = 0; i < oud.length; i += 1000) {
    const blok = oud.slice(i, i + 1000);
    try {
      await c.send(new DeleteObjectsCommand({ Bucket: r2Bucket(), Delete: { Objects: blok.map((o) => ({ Key: o.sleutel })) } }));
      verwijderd += blok.length;
      bytes += blok.reduce((t, o) => t + o.bytes, 0);
    } catch {
      // volgende keer opnieuw
    }
  }
  return { verwijderd, mb: Math.round(bytes / 1e6) };
}
