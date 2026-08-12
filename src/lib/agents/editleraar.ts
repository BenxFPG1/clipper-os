import { spawn } from 'node:child_process';
import { z } from 'zod';
import { structuredCall } from '../claude';
import { db } from '../supabase';
import { resolveBinary } from '../ingest/binaries';
import { ytdlpAuthArgs } from '../ingest/youtube';
import { fetchYoutubeCaptions } from '../ingest/youtube';
import { EFFECTEN } from '../vault/effecten';
import { EDITCRAFT } from '../vault/editcraft';
import { ONDERZOEK } from '../vault/onderzoek';

/**
 * De editleraar: traint de vault expliciet op editvakmanschap, met
 * YouTube-tutorials als leerstof.
 *
 * De kennis-agent doet brede wekelijkse webresearch; deze agent doet iets
 * anders — hij zoekt gericht edit-tutorials van makers (pacing, overgangen,
 * sound design, b-roll-sequencing), leest de transcripten en distilleert daar
 * regels uit in de toon van de bestaande kaders: concreet en toetsbaar, geen
 * "maak het dynamisch". Wat hij leert landt in vault_kennis (categorie
 * 'editcraft') en gaat vanaf dat moment automatisch mee in élke plan-,
 * script- en b-roll-call via geleerdeKennis().
 *
 * Effecten die wij nog niet kunnen renderen worden apart voorgesteld als
 * kandidaat-effect mét ffmpeg-recept — die voegen we bewust met de hand toe
 * aan de effectenvault, want een effect beloven dat de renderer niet kan
 * waarmaken is erger dan het niet kennen.
 */

const ZOEKTERMEN = [
  'b-roll sequencing tutorial how to order shots',
  'match cut tutorial editing',
  'j cut l cut editing tutorial',
  'speed ramp tutorial premiere',
  'editing rhythm pacing music video tutorial',
  'sound design transitions video editing',
];

/** Tutorials per run; elk kost een captions-download en promptruimte. */
const MAX_TUTORIALS = 6;
const MAX_TRANSCRIPT_TEKENS = 9000;

const lesSchema = z.object({
  regels: z
    .array(
      z.object({
        titel: z.string().max(80),
        inhoud: z
          .string()
          .describe('De regel, concreet en toetsbaar, toegepast op onze edits. Verwijs waar mogelijk naar onze effect-slugs.'),
        bron: z.string().describe('Titel + URL van de tutorial waar dit vandaan komt.'),
        waarom_waardevol: z.string(),
      }),
    )
    .max(6),
  kandidaat_effecten: z
    .array(
      z.object({
        naam: z.string().max(50),
        wat: z.string().describe('Wat het effect doet en wanneer je het inzet.'),
        ffmpeg_recept: z.string().describe('Hoe dit in ffmpeg-termen zou werken, zo concreet mogelijk.'),
        bron: z.string(),
      }),
    )
    .max(4),
  samenvatting: z.string(),
});

const SYSTEM = `Je bent de editleraar van een clipping-tool. Je krijgt transcripten van goed bekeken edit-tutorials plus onze bestaande kaders, en distilleert daaruit wat wij nog NIET weten.

Regels voor wat een les waard is:
1. Wat al in onze kaders staat, stel je niet opnieuw voor — ook niet in andere woorden.
2. Alleen kennis die een concrete beslissing in een edit verandert telt. "Zorg voor goede pacing" is geen les; "houd een establishing shot minstens 1,5s vast voordat je naar een detail knipt, anders registreert de kijker de locatie niet" wel.
3. Gaat een techniek over een effect dat wij al hebben (zie de effectenvault), verwijs dan naar onze slug en scherp de inzetregel aan.
4. Gaat het over een effect of overgang die wij nog niet kúnnen (whip pan, speed ramp, match cut op beweging), zet hem dan in kandidaat_effecten met een zo concreet mogelijk ffmpeg-recept — niet in de regels, want een regel over een effect dat de renderer niet kent is een belofte die stuk gaat.
5. Elke les noemt zijn bron (tutorialtitel + URL). Tutorials spreken elkaar soms tegen; kies dan wat het best onderbouwd is en zeg dat.
6. Liever twee scherpe lessen dan zes vage. Leeg is een geldige uitkomst.`;

export async function runEditleraar(): Promise<{ regels: number; kandidaten: number; samenvatting: string }> {
  const supabase = db();

  // Eerder geleerd (en eerder gebruikte tutorials, via de bron-kolom): niet
  // herhalen, en dezelfde tutorial niet twee keer lezen.
  const { data: bestaand } = await supabase
    .from('vault_kennis')
    .select('titel, inhoud, bron, actief')
    .order('created_at');
  const eerderGeleerd =
    bestaand && bestaand.length > 0
      ? `\n\n=== EERDER BIJGELEERD (niet herhalen; inactieve zijn door een mens afgekeurd) ===\n${bestaand
          .map((k) => `- [${k.actief ? 'actief' : 'AFGEKEURD'}] ${k.titel}: ${(k.inhoud as string).slice(0, 120)}`)
          .join('\n')}`
      : '';
  const gebruikteUrls = new Set(
    (bestaand ?? [])
      .map((k) => (k.bron as string | null)?.match(/https?:\/\/\S+/)?.[0])
      .filter((u): u is string => Boolean(u)),
  );

  // Tutorials zoeken: per zoekterm de best bekeken resultaten, ontdubbeld.
  // Zoeken op RELEVANTIE, niet op ruwe views: wereldwijd op views sorteren
  // levert massamarkt-tutorials in andere talen op (de eerste proefrun ving
  // precies dat). Per term de bovenste relevante resultaten, en titels in
  // niet-Latijns schrift vallen af — de lesstof moet leesbaar Engels of
  // Nederlands zijn.
  const kandidaten: { url: string; titel: string; volgorde: number }[] = [];
  for (const [termIndex, term] of ZOEKTERMEN.entries()) {
    try {
      const uit = await runYtdlp([
        '--flat-playlist', '--dump-json', '-I', '1:4',
        `https://www.youtube.com/results?search_query=${encodeURIComponent(term)}`,
      ]);
      let plek = 0;
      for (const regel of uit.split('\n')) {
        if (!regel.trim().startsWith('{')) continue;
        const entry = JSON.parse(regel) as { id?: string; title?: string; duration?: number };
        if (!entry.id || !entry.title) continue;
        // Tutorials zijn lang genoeg om inhoud te hebben, kort genoeg om te lezen.
        if (entry.duration !== undefined && (entry.duration < 180 || entry.duration > 2400)) continue;
        if (/[^\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F]/.test(entry.title)) continue;
        const url = `https://www.youtube.com/watch?v=${entry.id}`;
        if (gebruikteUrls.has(url)) continue;
        kandidaten.push({ url, titel: entry.title, volgorde: termIndex * 10 + plek });
        plek++;
      }
    } catch (e) {
      console.warn(`[editleraar] zoeken op "${term}" mislukt: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  const uniek = [...new Map(kandidaten.map((k) => [k.url, k])).values()]
    .sort((a, b) => a.volgorde - b.volgorde)
    .slice(0, MAX_TUTORIALS + 4);
  if (uniek.length === 0) throw new Error('Geen (nieuwe) tutorials gevonden.');

  // Transcripten ophalen; tutorials zonder ondertiteling vallen af.
  const lesstof: string[] = [];
  for (const t of uniek) {
    if (lesstof.length >= MAX_TUTORIALS) break;
    try {
      const captions = await fetchYoutubeCaptions(t.url);
      if (!captions || captions.segments.length < 10) continue;
      const tekst = captions.segments.map((s) => s.text).join(' ').slice(0, MAX_TRANSCRIPT_TEKENS);
      lesstof.push(`--- "${t.titel}" (${t.url}) ---\n${tekst}`);
      console.log(`[editleraar] lesstof: ${t.titel.slice(0, 70)}`);
    } catch {
      // stil overslaan; de volgende tutorial is even goed
    }
  }
  if (lesstof.length === 0) throw new Error('Geen tutorials met bruikbare ondertiteling gevonden.');

  const resultaat = await structuredCall({
    system: SYSTEM,
    user: `=== ONZE BESTAANDE KADERS (niet herhalen) ===
${EDITCRAFT}

${EFFECTEN}

${ONDERZOEK}${eerderGeleerd}

=== DE LESSTOF (${lesstof.length} tutorials) ===
${lesstof.join('\n\n')}`,
    schema: lesSchema,
    toolName: 'lever_editlessen',
    toolDescription: 'Lever de gedistilleerde editlessen en kandidaat-effecten.',
    maxTokens: 16000,
    effort: 'high',
    operation: 'editleraar',
  });

  for (const les of resultaat.regels) {
    await supabase.from('vault_kennis').insert({
      categorie: 'editcraft',
      titel: les.titel,
      inhoud: les.inhoud,
      bron: les.bron,
    });
  }
  // Kandidaat-effecten ook in vault_kennis, maar herkenbaar geprefixt en met
  // het recept erbij: zichtbaar op de Vault-pagina, en de handmatige toevoeging
  // aan de effectenvault heeft alles wat hij nodig heeft.
  for (const eff of resultaat.kandidaat_effecten) {
    await supabase.from('vault_kennis').insert({
      categorie: 'editcraft',
      titel: `kandidaat-effect: ${eff.naam}`,
      inhoud: `${eff.wat}\n\nffmpeg-recept: ${eff.ffmpeg_recept}\n\n(Nog niet in de renderer — pas inzetten nadat het effect echt gebouwd en getest is.)`,
      bron: eff.bron,
    });
  }

  await supabase.from('agent_runs').insert({
    agent: 'kennis',
    status: 'auto',
    proposal: { ...resultaat, agent: 'editleraar' },
    decided_by: 'auto',
  });

  return {
    regels: resultaat.regels.length,
    kandidaten: resultaat.kandidaat_effecten.length,
    samenvatting: resultaat.samenvatting,
  };
}

function runYtdlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const kind = spawn(resolveBinary('yt-dlp'), [...ytdlpAuthArgs(), '--no-warnings', ...args]);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      kind.kill('SIGKILL');
      reject(new Error('yt-dlp duurde langer dan 90s'));
    }, 90_000);
    kind.stdout.on('data', (d) => (stdout += d));
    kind.stderr.on('data', (d) => (stderr += d));
    kind.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    kind.on('close', (code) => {
      clearTimeout(timer);
      // yt-dlp geeft soms exit 1 bij deels gelukte flat listings; de JSON die
      // er wél is, is bruikbaar.
      if (code === 0 || stdout.trim().length > 0) resolve(stdout);
      else reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-200)}`));
    });
  });
}
