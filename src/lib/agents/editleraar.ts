import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { structuredCall } from '../claude';
import { db } from '../supabase';
import { resolveBinary } from '../ingest/binaries';
import { ytdlpAuthArgs } from '../ingest/youtube';
import { fetchYoutubeCaptions } from '../ingest/youtube';
import { pakFrames } from '../roughcut/frames';
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
  'short form video editing tips tiktok reels',
  'text animation kinetic typography tutorial',
  'zoom punch in transition tutorial capcut premiere',
  'color grading tutorial short form video',
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

const visueelSchema = z.object({
  effecten_gezien: z
    .array(
      z.object({
        naam: z.string().max(50),
        wat: z.string().describe('Wat er precies gebeurt in beeld, in eigen woorden — geen jargon zonder uitleg.'),
        herkend_als_slug: z
          .string()
          .nullable()
          .describe('De bestaande effect-slug uit onze vault als dit al een bekend effect is, anders null.'),
        inzetregel: z.string().describe('Wanneer dit werkt en wanneer niet, concreet toegepast op onze clips.'),
        ffmpeg_recept: z
          .string()
          .nullable()
          .describe('Alleen invullen als herkend_als_slug null is: hoe dit in ffmpeg-termen zou werken.'),
      }),
    )
    .max(4),
  niets_noemenswaardigs: z.boolean().describe('True als deze clip geen effect toont dat onze regels niet al dekken.'),
});

const VISUEEL_SYSTEM = `Je bent de editleraar, maar nu kijk je in plaats van dat je leest. Je krijgt frames van een clip die opvallend goed presteerde (een uitschieter t.o.v. het account), en je jaagt specifisch op TOFFE EFFECTEN — overgangen, zoom- of snelheidsingrepen, tekstanimatie, split-screen, timing-trucs — niet op algemeen vakmanschap (hook, ritme, kadrering horen bij de andere leraar-pas).

Regels:
1. Kijk eerst naar de frames vóór je oordeelt. Beschrijf wat je werkelijk ziet gebeuren tussen de frames, niet wat een edit "vaak doet".
2. Vergelijk met onze effectenvault (SFX_SLUGS en BEELD_EFFECT_SLUGS). Herken je het effect, verwijs dan naar de slug en scherp de inzetregel aan — verzin geen nieuwe naam voor iets dat we al hebben.
3. Zie je iets dat niet in onze vault staat, geef het dan een korte eigen naam en een zo concreet mogelijk ffmpeg-recept.
4. Een enkel frame-verschil is geen effect. Alleen dingen die een kijker echt zou opmerken en die wij morgen bewust zouden kunnen inzetten tellen.
5. Niets gezien dat het noemen waard is? Zeg dat gewoon — leeg is een geldige uitkomst.`;

/**
 * Kijkt naar de sterkste scout-vondsten en jaagt specifisch op effecten in
 * plaats van algemeen vakmanschap (dat doet bekijkTopVondsten al). Zelfde
 * frame-aanpak als kijken.ts, maar los gehouden: andere vraag, ander filter
 * op scout_finds.decoded (effecten_gezien i.p.v. visueel) zodat beide passen
 * onafhankelijk over dezelfde vondst kunnen lopen.
 */
export async function runEditleraarVisueel(aantal = 4): Promise<{ effecten: number; bekeken: number; fouten: string[] }> {
  const supabase = db();

  const { data } = await supabase
    .from('scout_finds')
    .select('id, post_url, handle, platform, outlier_score, decoded')
    .not('post_url', 'is', null)
    .order('outlier_score', { ascending: false, nullsFirst: false })
    .limit(30);

  const teDoen = (data ?? [])
    .filter((f) => !(f.decoded as { effecten_gezien?: unknown } | null)?.effecten_gezien)
    .slice(0, aantal);

  let effectenTotaal = 0;
  let bekeken = 0;
  const fouten: string[] = [];

  for (const find of teDoen) {
    let map: string | null = null;
    try {
      const frames = await pakFrames(find.post_url as string, { maxFrames: 10 });
      map = frames.map;
      if (frames.frames.length === 0) throw new Error('geen frames');

      const oordeel = await structuredCall({
        system: `${VISUEEL_SYSTEM}\n\n${EFFECTEN}`,
        user: `Clip van @${find.handle} op ${find.platform}${
          find.outlier_score ? ` (${find.outlier_score}x de mediaan van dat account)` : ''
        }. Duur: ${frames.duur ? `${Math.round(frames.duur)} seconden` : 'onbekend'}.`,
        schema: visueelSchema,
        toolName: 'lever_effectanalyse',
        toolDescription: 'Lever de gevonden effecten in deze clip.',
        maxTokens: 6000,
        effort: 'high',
        operation: 'editleraar_visueel',
        beeldPaden: frames.frames.map((f) => f.pad),
      });
      bekeken++;

      for (const eff of oordeel.effecten_gezien) {
        await supabase.from('vault_kennis').insert({
          categorie: 'editcraft',
          titel: eff.herkend_als_slug ? `Effect gezien: ${eff.herkend_als_slug}` : `kandidaat-effect: ${eff.naam}`,
          inhoud: eff.herkend_als_slug
            ? `${eff.wat}\n\nInzetregel: ${eff.inzetregel}`
            : `${eff.wat}\n\nInzetregel: ${eff.inzetregel}\n\nffmpeg-recept: ${eff.ffmpeg_recept ?? '—'}\n\n(Nog niet in de renderer — pas inzetten nadat het effect echt gebouwd en getest is.)`,
          bron: `Visueel gezien bij @${find.handle}: ${find.post_url}`,
        });
        effectenTotaal++;
      }

      await supabase
        .from('scout_finds')
        .update({ decoded: { ...(find.decoded as object | null), effecten_gezien: true } })
        .eq('id', find.id as string);
    } catch (e) {
      fouten.push(`@${find.handle}: ${(e as Error).message.slice(0, 100)}`);
    } finally {
      if (map) await rm(map, { recursive: true, force: true });
    }
  }

  return { effecten: effectenTotaal, bekeken, fouten };
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
