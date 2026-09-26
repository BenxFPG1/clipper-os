import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { structuredCall } from '../claude';
import { CLAUDE_LICHT_MODEL } from '../env';
import { resolveBinary } from '../ingest/binaries';
import type { TranscriptSegment } from '../ingest/transcript';
import type { VaultSnapshot } from '../vault';
import type { Energiemoment } from './schema';

/**
 * Fragmentkeuze op meer dan woorden.
 *
 * De schets en het toernooi kozen tot nu toe op tekst: een goed citaat, een
 * mooie wending. Maar wat een scrollende duim stopt is maar voor een deel de
 * tekst — het is de stilte vlak vóór een onthulling, een stem die versnelt,
 * een lach van de ander, een vraag die een antwoord afdwingt, en vooral: of
 * de eerste drie seconden op zichzelf te begrijpen zijn. Een clip die opent
 * met "dus toen zei hij…" verliest de kijker al vóór de hook, hoe sterk het
 * verhaal verderop ook is.
 *
 * Dit bestand meet per kandidaat-verhaallijn een compact pakket harde
 * signalen, puur mechanisch uit transcript, woordtijden en de energiemeting
 * (energie.ts). Optioneel, begrensd en alleen als de bronvideo al lokaal op
 * schijf staat: twee frames op het hookmoment laten beoordelen door het
 * lichte model (is er een expressie, is het beeld interessant). Nooit een
 * extra download alleen hiervoor — in CI draait de planner zonder bron, en
 * dan valt die laag gewoon weg.
 *
 * Het pakket gaat als meetdata het toernooi-examen en de verhaaldokter in:
 * geen oordeel, wel feiten waar ze hun oordeel op moeten baseren.
 */

export type Instap = { score: number; oordeel: 'sterk' | 'matig' | 'zwak'; redenen: string[]; tekst: string };

export type KandidaatSignalen = {
  kandidaat: number;
  titel: string;
  duur: number;
  instap: Instap;
  energie: { stiltes: number; pieken: number; tempo: number };
  /** Stilte (s) vlak vóór het payoff-shot, als die er is. */
  stilteVoorOnthulling: number | null;
  /** Spreektempo in de payoff gedeeld door het tempo ervóór; null als niet te meten. */
  tempoSprong: number | null;
  reacties: { markers: string[]; pieken: number };
  vraagAntwoord: number;
  aanloop: { dodeWoorden: number; aandeel: number };
  beeld?: { interessant: boolean; expressie: string } | null;
};

type SignaalShot = { volgorde: number; start: number; end: number; functie: string; transcript_fragment?: string };
type SignaalClip = { titel_intern: string; score?: number; shots: SignaalShot[] };
type Woord = { w: string; s: number; e: number };

// ------------------------------------------------------------------ tekstsignalen

/** Verbindingswoorden: wie hiermee opent, verwijst naar iets wat de kijker niet gehoord heeft. */
const VERBINDERS = [
  'en dan', 'en toen', 'dus', 'en', 'maar', 'want', 'of', 'daarom', 'toen', 'dan', 'daarna', 'verder', 'ook',
  'trouwens', 'omdat', 'terwijl', 'waardoor', 'waarna', 'zodat', 'nou', 'ja', 'nee', 'oké', 'ok', 'zo', 'so', 'and',
  'but', 'because', 'then', 'anyway',
];
/** Voornaamwoorden die een antecedent nodig hebben dat in de eerste seconden nog niet gevallen is. */
const VERWIJZERS = ['hij', 'zij', 'ze', 'hem', 'haar', 'hun', 'hen', 'die', 'dat', 'dit', 'daar', 'daarvan', 'ervan', 'erover', 'daarover', 'he', 'she', 'they', 'him', 'that', 'those'];
const OPVULLERS = ['eh', 'ehm', 'euh', 'uh', 'uhm', 'um', 'hm', 'nou', 'zeg maar', 'weet je', 'eigenlijk', 'gewoon', 'ik bedoel', 'you know', 'like'];

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Hoe goed werkt dit als eerste drie seconden? Een volledige, op zichzelf
 * begrijpelijke zin is sterk; een opening met een verbindingswoord of een
 * voornaamwoord zonder antecedent is zwak — de kijker mist de context en
 * swipet. Een vraag of een getal vooraan trekt juist.
 */
export function instappuntKwaliteit(tekst: string): Instap {
  const schoon = tekst.replace(/\s+/g, ' ').trim();
  const woorden = schoon.split(' ').filter(Boolean);
  const laag = woorden.map(norm);
  const redenen: string[] = [];
  let score = 0.7;

  if (woorden.length === 0) return { score: 0, oordeel: 'zwak', redenen: ['geen spraak in de eerste seconden'], tekst: '' };

  const begin2 = `${laag[0]} ${laag[1] ?? ''}`.trim();
  const verbinder = VERBINDERS.find((v) => (v.includes(' ') ? begin2 === v : laag[0] === v));
  if (verbinder) {
    score -= 0.35;
    redenen.push(`begint met "${verbinder}"`);
  }
  // Opvulling vooraan, en hoe meer ervan hoe erger: "eh ja nou kijk" is vier
  // woorden waarin de kijker nog niets weet.
  const opvuller = OPVULLERS.find((o) => (o.includes(' ') ? begin2 === o : laag[0] === o));
  const aanloopWoorden = laag.slice(0, 4).filter((w) => OPVULLERS.includes(w) || ['ja', 'nee', 'nou', 'kijk'].includes(w)).length;
  if (opvuller && opvuller !== verbinder) {
    score -= 0.2 + 0.1 * Math.max(0, aanloopWoorden - 1);
    redenen.push(`begint met opvulling "${opvuller}"`);
  }

  // Een verwijzer in de eerste vier woorden zonder eigennaam ervóór: "hij
  // zei dat…" — wie? Een eigennaam midden in de zin (hoofdletter, niet het
  // eerste woord) telt als antecedent.
  const eersteVier = laag.slice(0, 4);
  const verwijzerIndex = eersteVier.findIndex((w) => VERWIJZERS.includes(w));
  if (verwijzerIndex >= 0) {
    const naamErvoor = woorden.slice(1, verwijzerIndex).some((w) => /^\p{Lu}/u.test(w));
    // "dat" en "die" als bijzin-inleider na een zelfstandig naamwoord ("het
    // geld dat…") is geen verwijzing naar buiten; alleen vooraan telt dat.
    const alleenVooraan = ['dat', 'die', 'dit', 'that', 'those'].includes(eersteVier[verwijzerIndex]);
    if (!naamErvoor && (!alleenVooraan || verwijzerIndex === 0 || (verbinder && verwijzerIndex === 1))) {
      score -= 0.25;
      redenen.push(`"${eersteVier[verwijzerIndex]}" zonder antecedent`);
    }
  }

  // Zinseinde binnen het venster: een complete gedachte in drie seconden.
  const eindIndex = woorden.findIndex((w) => /[.!?]$/.test(w));
  if (eindIndex >= 2) {
    score += 0.15;
    redenen.push('volledige zin binnen 3 s');
  } else if (eindIndex < 0 && woorden.length >= 10) {
    score -= 0.05;
    redenen.push('zin loopt door na 3 s');
  }
  const eersteZin = eindIndex >= 0 ? woorden.slice(0, eindIndex + 1).join(' ') : schoon;
  if (/\?/.test(eersteZin)) {
    score += 0.1;
    redenen.push('opent met een vraag');
  }
  if (/\d|miljoen|miljard|procent|duizend|honderd|euro/i.test(eersteZin)) {
    score += 0.1;
    redenen.push('getal vooraan');
  }

  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  return { score, oordeel: score >= 0.7 ? 'sterk' : score >= 0.45 ? 'matig' : 'zwak', redenen, tekst: schoon.slice(0, 120) };
}

/** Lach- en reactiemarkers zoals whisper en ondertitels ze schrijven, plus losse interjecties. */
export function lachmarkers(tekst: string): string[] {
  const uit: string[] = [];
  const patronen: [RegExp, string][] = [
    [/[([]\s*(lacht|lachen|gelach|lach|laughs?|laughter|laughing)\s*[)\]]/gi, '(lacht)'],
    [/[([]\s*(applaus|applause|gejuich)\s*[)\]]/gi, '(applaus)'],
    [/\b(ha){2,}h?\b|\bhihi+\b|\bhehe+\b/gi, 'haha'],
    [/\b(wauw|wow|jezus|pff+|oh my god|omg|serieus\?|echt\?!?|wat\?!|nee!)/gi, 'interjectie'],
  ];
  for (const [re, label] of patronen) {
    const n = tekst.match(re)?.length ?? 0;
    for (let i = 0; i < n; i++) uit.push(label);
  }
  return uit;
}

/**
 * Vraag→antwoord-paren: een segment dat op een vraagteken eindigt, binnen vier
 * seconden gevolgd door een inhoudelijk antwoord (minstens drie woorden, zelf
 * geen vraag). Dat patroon is een ingebouwde open lus: de kijker wil het
 * antwoord horen.
 */
export function vraagAntwoordParen(segmenten: TranscriptSegment[]): number {
  let paren = 0;
  for (let i = 0; i + 1 < segmenten.length; i++) {
    const vraag = segmenten[i];
    if (!/\?\s*$/.test(vraag.text.trim())) continue;
    const antwoord = segmenten[i + 1];
    if (antwoord.start_seconds - vraag.end_seconds > 4) continue;
    const woorden = antwoord.text.trim().split(/\s+/).filter(Boolean);
    if (woorden.length >= 3 && !/\?\s*$/.test(antwoord.text.trim())) paren++;
  }
  return paren;
}

/** Dode woorden: opvulling en directe herhaling ("ik ik"), als aantal en aandeel. */
export function dodeWoorden(tekst: string): { dodeWoorden: number; aandeel: number } {
  const woorden = tekst.split(/\s+/).map(norm).filter(Boolean);
  if (woorden.length === 0) return { dodeWoorden: 0, aandeel: 0 };
  let dood = 0;
  for (let i = 0; i < woorden.length; i++) {
    const paar = i > 0 ? `${woorden[i - 1]} ${woorden[i]}` : '';
    if (OPVULLERS.includes(woorden[i]) || OPVULLERS.includes(paar) || (i > 0 && woorden[i] === woorden[i - 1])) dood++;
  }
  return { dodeWoorden: dood, aandeel: Math.round((dood / woorden.length) * 100) / 100 };
}

// ------------------------------------------------------------------ tijdsignalen

/**
 * Woorden in een venster. Met woordtijden (de gecachte brontranscriptie) exact;
 * anders benaderd uit de transcriptsegmenten door de woorden gelijkmatig over
 * het segment te verdelen — grof, maar voor "wat klinkt er in de eerste drie
 * seconden" ruim goed genoeg.
 */
export function woordenInVenster(
  van: number,
  tot: number,
  transcript: TranscriptSegment[],
  bronWoorden?: Woord[] | null,
): Woord[] {
  if (bronWoorden && bronWoorden.length > 0) {
    return bronWoorden.filter((w) => (w.s + w.e) / 2 >= van && (w.s + w.e) / 2 < tot);
  }
  const uit: Woord[] = [];
  for (const seg of transcript) {
    if (seg.end_seconds <= van || seg.start_seconds >= tot) continue;
    const woorden = seg.text.trim().split(/\s+/).filter(Boolean);
    const duur = Math.max(0.01, seg.end_seconds - seg.start_seconds);
    woorden.forEach((w, i) => {
      const s = seg.start_seconds + (i / woorden.length) * duur;
      const e = seg.start_seconds + ((i + 1) / woorden.length) * duur;
      if ((s + e) / 2 >= van && (s + e) / 2 < tot) uit.push({ w, s, e });
    });
  }
  return uit;
}

const overlapt = (a: { start: number; end: number }, van: number, tot: number) => a.start < tot && a.end > van;

/** Meet het signalenpakket voor elke kandidaat. Puur rekenwerk; nooit een reden om te falen. */
export function meetSignalen(
  clips: SignaalClip[],
  transcript: TranscriptSegment[],
  energie: Energiemoment[] = [],
  bronWoorden?: Woord[] | null,
): KandidaatSignalen[] {
  return clips.map((clip, i) => {
    const shots = [...clip.shots].sort((a, b) => a.volgorde - b.volgorde);
    const eerste = shots[0];
    const duur = shots.reduce((t, s) => t + Math.max(0, s.end - s.start), 0);
    const inShots = (m: { start: number; end: number }) => shots.some((s) => overlapt(m, s.start - 1, s.end + 1));

    const instapWoorden = eerste ? woordenInVenster(eerste.start, eerste.start + 3, transcript, bronWoorden) : [];
    const instap = instappuntKwaliteit(instapWoorden.map((w) => w.w).join(' '));

    const binnen = energie.filter(inShots);
    const telling = {
      stiltes: binnen.filter((m) => m.soort === 'stilte').length,
      pieken: binnen.filter((m) => m.soort === 'volumepiek').length,
      tempo: binnen.filter((m) => m.soort === 'tempowisseling').length,
    };

    // De onthulling: het eerste payoff-shot (anders de barst, anders het
    // laatste shot). Stilte daarvóór — gemeten in de audio, of als gat tussen
    // de woorden — is de spanning die een clip laat ademen vóór de klap.
    const payoff = shots.find((s) => s.functie === 'payoff') ?? shots.find((s) => s.functie === 'barst') ?? shots[shots.length - 1];
    let stilteVoorOnthulling: number | null = null;
    if (payoff) {
      const stilte = energie
        .filter((m) => m.soort === 'stilte' && overlapt(m, payoff.start - 3, payoff.start + 0.5))
        .reduce((max, m) => Math.max(max, m.end - m.start), 0);
      const ws = woordenInVenster(payoff.start - 3, payoff.start + 1, transcript, bronWoorden);
      let gat = 0;
      for (let k = 0; k + 1 < ws.length; k++) gat = Math.max(gat, ws[k + 1].s - ws[k].e);
      const langste = Math.max(stilte, bronWoorden ? gat : 0);
      if (langste >= 0.7) stilteVoorOnthulling = Math.round(langste * 10) / 10;
    }

    // Spreektempo in de payoff tegenover de rest: een stem die versnelt of
    // juist inhoudt op het moment dat het ertoe doet.
    let tempoSprong: number | null = null;
    if (payoff && shots.length > 1) {
      const wps = (ss: SignaalShot[]) => {
        const d = ss.reduce((t, s) => t + Math.max(0, s.end - s.start), 0);
        const n = ss.reduce((t, s) => t + woordenInVenster(s.start, s.end, transcript, bronWoorden).length, 0);
        return d > 1 ? n / d : null;
      };
      const a = wps(shots.filter((s) => s !== payoff));
      const b = wps([payoff]);
      if (a && b) tempoSprong = Math.round((b / a) * 100) / 100;
    }

    // Reacties: markers in de tekst, en volumepieken die vlak na een zinseinde
    // vallen — dat is vaak de lach of het "wat?!" van de ander.
    const shotTekst = shots.map((s) => woordenInVenster(s.start, s.end, transcript, bronWoorden).map((w) => w.w).join(' ')).join(' ');
    const segmentTekst = transcript
      .filter((seg) => shots.some((s) => seg.start_seconds < s.end && seg.end_seconds > s.start))
      .map((seg) => seg.text)
      .join(' ');
    const markers = lachmarkers(`${segmentTekst} ${shotTekst}`);
    // Een marker als "(lacht)" achter de punt verbergt het zinseinde niet.
    const zinseinden = transcript
      .filter((seg) => /[.!?]\s*$/.test(seg.text.replace(/[([][^)\]]*[)\]]/g, '').trim()))
      .map((seg) => seg.end_seconds);
    const reactiePieken = binnen.filter(
      (m) => m.soort === 'volumepiek' && zinseinden.some((z) => m.start >= z - 0.2 && m.start <= z + 1.5),
    ).length;

    const relevant = transcript.filter((seg) => shots.some((s) => seg.start_seconds < s.end && seg.end_seconds > s.start));

    return {
      kandidaat: i + 1,
      titel: clip.titel_intern,
      duur: Math.round(duur),
      instap,
      energie: telling,
      stilteVoorOnthulling,
      tempoSprong,
      reacties: { markers: [...new Set(markers)], pieken: reactiePieken },
      vraagAntwoord: vraagAntwoordParen(relevant),
      aanloop: dodeWoorden(shotTekst),
    };
  });
}

// ------------------------------------------------------------------ beeld (optioneel)

/**
 * De bronvideo, als die al lokaal op schijf staat — op de plekken waar de
 * render-worker en het lokale roughcut-script hem neerzetten, of als de bron
 * zelf een bestand is. Anders null: de planner downloadt voor twee frames
 * niet een hele video (energie.ts haalt alleen audio, en dat blijft zo).
 */
export function lokaleBron(videoId: string | null | undefined, sourceUrl: string | null | undefined): string | null {
  const kandidaten = [
    videoId ? join(tmpdir(), 'clipper-bron', videoId, 'bron.mp4') : null,
    videoId ? join(homedir(), 'Movies', 'Clipper OS', '.werk', videoId, 'bron.mp4') : null,
    sourceUrl?.startsWith('file://') ? sourceUrl.slice(7) : null,
    sourceUrl?.startsWith('/') ? sourceUrl : null,
  ].filter((p): p is string => Boolean(p));
  return kandidaten.find((p) => existsSync(p)) ?? null;
}

const beeldSchema = z.object({
  kandidaten: z.array(
    z.object({
      kandidaat: z.number().int().min(1),
      interessant: z.boolean().describe('Zou dit beeld een scrollende duim stoppen (expressie, beweging, iets onverwachts)?'),
      expressie: z.string().describe('In maximaal zes woorden wat er te zien is: gezichtsexpressie of beeld.'),
    }),
  ),
});

/** Hoogstens zoveel kandidaten krijgen een beeldoordeel; elk frame telt mee in de limiet. */
export const MAX_BEELD_KANDIDATEN = 8;

/**
 * Twee frames op het hookmoment per kandidaat, één call op het lichte model
 * voor allemaal. Best-effort: zonder lokale bron, zonder ffmpeg of bij een
 * fout komt er een lege map terug en werkt de rest gewoon door.
 */
export async function beoordeelHookBeelden(
  kandidaten: { kandidaat: number; hookStart: number }[],
  bronPad: string | null,
): Promise<Map<number, { interessant: boolean; expressie: string }>> {
  const uit = new Map<number, { interessant: boolean; expressie: string }>();
  if (!bronPad || kandidaten.length === 0) return uit;
  const selectie = kandidaten.slice(0, MAX_BEELD_KANDIDATEN);
  const map = await mkdtemp(join(tmpdir(), 'clipper-signaal-'));
  try {
    const beelden: { kandidaat: number; pad: string }[] = [];
    for (const k of selectie) {
      for (const [n, dt] of [0.4, 1.6].entries()) {
        const pad = join(map, `k${k.kandidaat}-${n}.jpg`);
        const gelukt = await frame(bronPad, k.hookStart + dt, pad);
        if (gelukt) beelden.push({ kandidaat: k.kandidaat, pad });
      }
    }
    if (beelden.length === 0) return uit;
    const oordeel = await structuredCall({
      system:
        'Je beoordeelt openingsbeelden van korte clips (TikTok/Reels/Shorts). Per kandidaat krijg je twee frames uit de eerste twee seconden. Oordeel alleen over wat je ziet: stopt dit beeld een scrollende duim? Een sprekend hoofd met een neutrale blik is niet interessant; een uitgesproken expressie (lachen, schrikken, ongeloof, boosheid), een gebaar, een tweede persoon die reageert of iets onverwachts in beeld wel. Wees streng.',
      user: `Beelden in deze volgorde: ${beelden.map((b) => `kandidaat ${b.kandidaat}`).join(', ')}. Geef per kandidaat één oordeel.`,
      schema: beeldSchema,
      toolName: 'lever_beeldoordeel',
      toolDescription: 'Lever per kandidaat of het openingsbeeld interessant is.',
      maxTokens: 2000,
      effort: 'low',
      operation: 'planner_hookbeeld',
      beeldPaden: beelden.map((b) => b.pad),
      model: CLAUDE_LICHT_MODEL,
    });
    for (const k of oordeel.kandidaten) uit.set(k.kandidaat, { interessant: k.interessant, expressie: k.expressie.slice(0, 60) });
  } catch (e) {
    console.warn('[signalen] beeldoordeel overgeslagen:', (e as Error).message.slice(0, 120));
  } finally {
    await rm(map, { recursive: true, force: true });
  }
  return uit;
}

function frame(bron: string, seconde: number, pad: string): Promise<boolean> {
  return new Promise((klaar) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      ['-nostdin', '-y', '-ss', Math.max(0, seconde).toFixed(2), '-i', bron, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', pad],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    kind.on('error', () => klaar(false));
    kind.on('close', (code) => klaar(code === 0 && existsSync(pad)));
  });
}

// ------------------------------------------------------------------ naar de prompt

const komma = (n: number) => String(n).replace('.', ',');

/** Eén regel per kandidaat; het examen en de verhaaldokter lezen dit als harde meetdata. */
export function signaalRegel(s: KandidaatSignalen): string {
  const delen = [
    `instap ${s.instap.oordeel} (${komma(s.instap.score)}${s.instap.redenen.length ? `: ${s.instap.redenen.join(', ')}` : ''}; "${s.instap.tekst.slice(0, 70)}")`,
  ];
  if (s.beeld) delen.push(`hookbeeld ${s.beeld.interessant ? 'interessant' : 'vlak'} (${s.beeld.expressie})`);
  if (s.stilteVoorOnthulling !== null) delen.push(`stilte vóór onthulling ${komma(s.stilteVoorOnthulling)} s`);
  if (s.tempoSprong !== null && (s.tempoSprong >= 1.25 || s.tempoSprong <= 0.75)) {
    delen.push(`tempo payoff ×${komma(s.tempoSprong)} (${s.tempoSprong > 1 ? 'versnelt' : 'houdt in'})`);
  }
  if (s.reacties.markers.length || s.reacties.pieken) {
    delen.push(`reactie: ${[...s.reacties.markers, ...(s.reacties.pieken ? [`${s.reacties.pieken} volumepiek(en) na een zinseinde`] : [])].join(', ')}`);
  }
  if (s.vraagAntwoord) delen.push(`vraag→antwoord ×${s.vraagAntwoord}`);
  if (s.aanloop.aandeel >= 0.04) delen.push(`dode woorden ${Math.round(s.aanloop.aandeel * 100)}%`);
  const e = s.energie;
  if (e.stiltes || e.pieken || e.tempo) delen.push(`energie: ${e.stiltes} stilte, ${e.pieken} piek, ${e.tempo} tempowissel`);
  delen.push(`${s.duur} s`);
  return delen.join(' | ');
}

export function signalenVoorPrompt(signalen: KandidaatSignalen[]): string {
  if (signalen.length === 0) return '';
  return signalen.map((s) => `k${s.kandidaat} "${s.titel.slice(0, 50)}": ${signaalRegel(s)}`).join('\n');
}

/**
 * "Wat werkt bij anderen": de gemeten editnormen van externe top-clips en de
 * trend-top-5 uit de vault, compact. Leeg als geen van beide er is.
 */
export function watWerktBijAnderen(vault: VaultSnapshot, normen: string): string {
  const t = vault.trends;
  const trends =
    t && (t.hooks.length > 0 || t.structuren.length > 0)
      ? `Trend (${t.periodeDagen} dagen, andere accounts): hooks ${t.hooks.map((h) => h.slug).join(', ') || '—'}; structuren ${t.structuren.map((s) => s.slug).join(', ') || '—'}.`
      : '';
  return [normen.trim(), trends].filter(Boolean).join('\n');
}
