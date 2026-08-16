import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { r2Download, r2Upload } from './r2';

const MAP = 'muziekbedden';

/**
 * Waar het muziekbed onder een clip vandaan komt.
 *
 * - `lokaal` (standaard): de gesynthetiseerde bedden uit assets/muziek. Gratis,
 *   rechtenvrij, sober.
 * - `elevenlabs`: laat een bed genereren dat past bij deze specifieke clip. Dit
 *   is een officiële API met commercieel gebruiksrecht op de output.
 * - `suno_compat`: elke dienst die de Suno-achtige "genereer en poll"-vorm
 *   aanbiedt, via MUZIEK_BASIS_URL. Suno zelf heeft geen publieke API — de
 *   aanbieders die dat wel claimen zijn doorverkopers, met het risico dat ze
 *   omvallen of tegen de voorwaarden van Suno in werken. Daarom niet de
 *   standaard, maar wel mogelijk als jij die keuze bewust maakt.
 */
export type MuziekProvider = 'lokaal' | 'elevenlabs' | 'suno_compat';

export function muziekProvider(): MuziekProvider {
  const p = process.env.MUZIEK_PROVIDER as MuziekProvider | undefined;
  return p === 'elevenlabs' || p === 'suno_compat' ? p : 'lokaal';
}

/**
 * Levert het pad naar een muziekbed voor deze clip.
 *
 * Het resultaat wordt gecachet op de combinatie van sfeer, duur en de
 * beschrijving: twee clips met dezelfde sfeer delen dus één bed in plaats van
 * elke render opnieuw te genereren. Dat scheelt geld en houdt de clips van één
 * campagne bij elkaar horen.
 *
 * Lukt genereren niet, dan valt hij terug op het lokale bed. Een clip zonder
 * muziek is beter dan een render die faalt.
 */
export async function zorgVoorMuziekbed(
  sfeer: string,
  opties: {
    werkmap: string;
    seconden: number;
    /** Waar de clip over gaat; stuurt de generatie. */
    beschrijving?: string;
    log?: (m: string) => void;
  },
): Promise<string | undefined> {
  if (!sfeer || sfeer === 'geen') return undefined;

  const lokaal = join(process.cwd(), 'assets', 'muziek', `${sfeer}.mp3`);
  const provider = muziekProvider();
  if (provider === 'lokaal') return existsSync(lokaal) ? lokaal : undefined;

  const prompt = maakPrompt(sfeer, opties.beschrijving);
  const sleutel = createHash('sha1').update(`${provider}|${prompt}`).digest('hex').slice(0, 16);
  const doel = join(opties.werkmap, `bed-${sleutel}.mp3`);
  if (existsSync(doel)) return doel;

  // Al eerder gegenereerd voor een andere clip of een eerdere render? Dan
  // hergebruiken we dat bestand in plaats van opnieuw te betalen.
  const opslagPad = `${MAP}/${sleutel}.mp3`;
  const bestaand = await r2Download(opslagPad);
  if (bestaand.data) {
    await mkdir(opties.werkmap, { recursive: true });
    await writeFile(doel, Buffer.from(await bestaand.data.arrayBuffer()));
    opties.log?.(`muziekbed hergebruikt (${sfeer})`);
    return doel;
  }

  try {
    const bytes =
      provider === 'elevenlabs'
        ? await genereerElevenLabs(prompt, opties.seconden)
        : await genereerSunoCompat(prompt, opties.seconden);

    await mkdir(opties.werkmap, { recursive: true });
    await writeFile(doel, bytes);
    await r2Upload(opslagPad, bytes, 'audio/mpeg');
    opties.log?.(`muziekbed gegenereerd (${sfeer}, ${provider})`);
    return doel;
  } catch (e) {
    opties.log?.(`muziek genereren mislukt (${(e as Error).message.slice(0, 90)}); lokaal bed`);
    return existsSync(lokaal) ? lokaal : undefined;
  }
}

/**
 * De sfeer uit de effectenvault vertalen naar een muziekopdracht. Bewust
 * instrumentaal en zonder opvallende melodie: een bed dat je bewust hoort,
 * steelt de aandacht van wat er gezegd wordt (editcraft).
 */
function maakPrompt(sfeer: string, beschrijving?: string): string {
  const basis: Record<string, string> = {
    spanningsbed:
      'Minimal instrumental underscore for a talking-head video. Low sustained drone, subtle pulse, no melody, no drums fills, no vocals. Tense but restrained, sits under speech.',
    opbouw:
      'Instrumental underscore that slowly builds tension over its length. Starts sparse, adds a rising pulse, no vocals, no melody in the foreground. Ends without resolution.',
    luchtig:
      'Light, warm instrumental underscore. Soft plucked notes, gentle pulse, no vocals, unobtrusive. Friendly but not cheerful stock-music.',
    trending_sound:
      'Modern short-form instrumental bed with a simple recognisable pulse, no vocals, mixed to sit under speech.',
  };
  const kern = basis[sfeer] ?? basis.spanningsbed;
  return beschrijving ? `${kern} Context of the clip: ${beschrijving.slice(0, 200)}` : kern;
}

/** Officiële muziek-API met commercieel gebruiksrecht; geeft direct audio terug. */
async function genereerElevenLabs(prompt: string, seconden: number): Promise<Buffer> {
  const sleutel = process.env.ELEVENLABS_API_KEY;
  if (!sleutel) throw new Error('ELEVENLABS_API_KEY ontbreekt');

  const res = await fetch('https://api.elevenlabs.io/v1/music', {
    method: 'POST',
    headers: { 'xi-api-key': sleutel, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      // Binnen de grenzen van de API (3s–10min), met marge zodat het bed nooit
      // korter is dan de clip.
      music_length_ms: Math.min(600_000, Math.max(10_000, Math.round((seconden + 6) * 1000))),
      model_id: process.env.ELEVENLABS_MUSIC_MODEL ?? 'music_v2',
      force_instrumental: true,
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!res.ok) throw new Error(`ElevenLabs gaf ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Een dienst met de gebruikelijke "start een taak, pol tot hij klaar is"-vorm
 * die de Suno-doorverkopers aanbieden. Basis-URL en sleutel komen uit env,
 * zodat je van aanbieder kunt wisselen zonder code te veranderen.
 */
async function genereerSunoCompat(prompt: string, seconden: number): Promise<Buffer> {
  const basis = process.env.MUZIEK_BASIS_URL;
  const sleutel = process.env.MUZIEK_API_KEY;
  if (!basis || !sleutel) throw new Error('MUZIEK_BASIS_URL of MUZIEK_API_KEY ontbreekt');

  const start = await fetch(`${basis.replace(/\/$/, '')}/api/v1/generate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sleutel}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      instrumental: true,
      customMode: false,
      model: process.env.MUZIEK_MODEL ?? 'V4_5',
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!start.ok) throw new Error(`generatie gaf ${start.status}`);

  const gestart = (await start.json()) as { data?: { taskId?: string } };
  const taak = gestart.data?.taskId;
  if (!taak) throw new Error('geen taskId in het antwoord');

  // Pollen: deze diensten leveren pas na tientallen seconden.
  for (let poging = 0; poging < 40; poging++) {
    await new Promise((r) => setTimeout(r, 5000));
    const stand = await fetch(
      `${basis.replace(/\/$/, '')}/api/v1/generate/record-info?taskId=${encodeURIComponent(taak)}`,
      { headers: { authorization: `Bearer ${sleutel}` }, signal: AbortSignal.timeout(30_000) },
    );
    if (!stand.ok) continue;
    const j = (await stand.json()) as {
      data?: { status?: string; response?: { sunoData?: { audioUrl?: string }[] } };
    };
    const url = j.data?.response?.sunoData?.[0]?.audioUrl;
    if (url) {
      const audio = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!audio.ok) throw new Error(`audio ophalen gaf ${audio.status}`);
      return Buffer.from(await audio.arrayBuffer());
    }
    if (j.data?.status && /fail|error/i.test(j.data.status)) throw new Error(`taak ${j.data.status}`);
  }
  throw new Error('taak niet op tijd klaar');
  void seconden;
}
