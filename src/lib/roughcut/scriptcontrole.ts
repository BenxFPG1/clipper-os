import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { woordenVanFragment } from './uitlijnen';
import type { Shot } from './index';

/**
 * De laatste verdedigingslinie voor "de clip moet het script volgen": het
 * gerenderde bestand wordt terugvertaald naar tekst en vergeleken met wat het
 * plan voorschreef.
 *
 * Alle controles hiervóór werken op tijdcodes en geluidsniveaus — die vangen
 * afgekapte woorden en schuivende knippen, maar níet een shot dat per ongeluk
 * dezelfde zin twee keer laat horen, of een fragment dat na alle verschuivingen
 * iets anders zegt dan gepland. Dat hoor je alleen door te luisteren, en dit is
 * de geautomatiseerde vorm daarvan.
 */

export type ScriptOordeel = {
  /** Aandeel van de scriptwoorden dat in de clip terugkomt (0..1). */
  dekking: number;
  /** Zinnen van 4+ woorden die twee keer in de clip klinken. */
  herhalingen: { tekst: string; eerste: number; tweede: number }[];
  woorden: number;
  /**
   * Spraak vóór de eerste scriptzin: hoeveel seconden, en wat er gezegd wordt.
   * Null als de clip meteen met de scripttekst begint (of dat niet te bepalen
   * is). Dit vangt precies het losse "Ja," of de staart van een vorige zin.
   */
  aanloop: { seconden: number; tekst: string } | null;
  /**
   * Per segment: is het begin van zijn scriptfragment terug te horen, en op
   * welke seconde? Een fragment waarvan de kop nergens klinkt is vrijwel zeker
   * middenin de zin aangesneden — precies wat als "random geknipt" voelt.
   */
  perShot: { volgorde: number; gevonden: boolean; opSeconde: number | null }[];
};

export const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Zoekt waar de kop van een fragment voor het eerst voorkomt in een
 * woordenreeks. Dit is de kern van zowel de aanloop-detectie als "script
 * gevolgd" — allebei vroegen ze zich af "waar begint dit stukje tekst
 * écht in wat er te horen is", en allebei hadden ze onafhankelijk
 * dezelfde twee meetbugs, tot ze hier samengevoegd werden:
 *
 * 1. Een fragment dat begint met een kort woordje ("en", "is", "er", "het")
 *    werd gemist als de kandidatenlijst woorden onder de 3 letters
 *    wegfiltert — de zoektocht sloeg dan de eigen, correcte openingswoorden
 *    van de zin over en vond "bewijs" pas bij het eerste lange woord erna.
 *    Zo werd een clip die exact op zijn scripttekst begon ("En dan is er
 *    nog het waterstofverhaal") afgekeurd als "aanloop: En dan is er".
 * 2. Een koppelteken in de scripttekst ("Platina-markt") werd door de
 *    tokenizer tot één woord samengeplakt, terwijl whisper het losgesproken
 *    hoort als twee woorden ("platina" + "markt") — waardoor de exacte
 *    match zijn doel domweg miste.
 *
 * Twee stappen: eerst een exacte match op de eerste twee woorden van het
 * fragment (geen lengte-ondergrens, koppeltekens tellen als woordgrens) —
 * het sterkste bewijs. Lukt dat niet (whisper hoorde het allereerste woord
 * anders), dan de ruimere terugval: twee van de eerste vijf woorden van
 * 3+ letters ergens dicht bij elkaar; transcriptie mist er altijd wel een.
 */
export function vindKopIndex(
  fragment: string,
  woorden: { n: string }[],
  limiet = woorden.length,
): number | null {
  const grens = Math.min(limiet, woorden.length);
  const kopRuw = fragment.split(/[\s-]+/).map(norm).filter(Boolean);
  if (kopRuw[0] && kopRuw[1]) {
    for (let i = 0; i < grens; i++) {
      if (woorden[i].n === kopRuw[0] && woorden[i + 1]?.n === kopRuw[1]) return i;
    }
  }
  const kop = fragment.split(/[\s-]+/).map(norm).filter((w) => w.length >= 3).slice(0, 5);
  for (let i = 0; i < grens; i++) {
    if (kop.includes(woorden[i].n) && (kop.includes(woorden[i + 1]?.n) || kop.includes(woorden[i + 2]?.n))) {
      return i;
    }
  }
  return null;
}

export async function controleerScript(
  montagePad: string,
  segmenten: (Shot & { transcript_fragment?: string })[],
  opties: { model?: string } = {},
): Promise<ScriptOordeel | null> {
  const model = opties.model ?? process.env.WHISPER_ALIGN_MODEL ?? 'base';
  const werkmap = await mkdtemp(join(tmpdir(), 'clipper-script-'));

  try {
    const wav = join(werkmap, 'clip.wav');
    await new Promise<void>((klaar, fout) => {
      const kind = spawn(
        resolveBinary('ffmpeg'),
        ['-nostdin', '-y', '-i', montagePad, '-vn', '-ac', '1', '-ar', '16000', wav],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      kind.stderr.on('data', (d) => (stderr += d));
      kind.on('error', fout);
      kind.on('close', (code) => (code === 0 ? klaar() : fout(new Error(stderr.slice(-120)))));
    });

    const gehoord = await woordenVanFragment(wav, model);
    if (gehoord.length < 8) return null;

    const woorden = gehoord.map((w) => ({ ...w, n: norm(w.w) })).filter((w) => w.n.length > 0);

    // Herhaalde zinnen: een reeks van vier of meer woorden die verderop nog
    // eens klinkt. Vier is bewust de grens — losse woorden en korte frasen
    // ("en dan", "goud") herhalen mensen constant, hele zinsdelen niet.
    const herhalingen: ScriptOordeel['herhalingen'] = [];
    const REEKS = 4;
    const gezien = new Map<string, number>(); // sleutel -> index van eerste keer
    for (let i = 0; i + REEKS <= woorden.length; i++) {
      const sleutel = woorden.slice(i, i + REEKS).map((w) => w.n).join(' ');
      const eerste = gezien.get(sleutel);
      if (eerste === undefined) {
        gezien.set(sleutel, i);
        continue;
      }
      // Alleen echte herhaling: verderop in de clip, niet direct aansluitend
      // (stotteren of een gestrekte zin telt niet).
      if (woorden[i].s - woorden[eerste].s > 3) {
        const vorige = herhalingen[herhalingen.length - 1];
        // Overlappende vensters samenvoegen tot één melding.
        if (vorige && woorden[i].s - vorige.tweede < 2.5) {
          vorige.tekst = `${vorige.tekst} ${woorden[i + REEKS - 1].w}`;
        } else {
          herhalingen.push({
            tekst: woorden.slice(i, i + REEKS).map((w) => w.w).join(' '),
            eerste: Math.round(woorden[eerste].s * 10) / 10,
            tweede: Math.round(woorden[i].s * 10) / 10,
          });
        }
      }
    }

    // Dekking: welk deel van de scriptwoorden komt terug in de clip? Grofweg —
    // transcriptie verhaspelt namen — dus we tellen per fragment het aandeel
    // herkende woorden en middelen dat.
    const inClip = new Set(woorden.map((w) => w.n));
    const fragmenten = segmenten
      .map((s) => s.transcript_fragment)
      .filter((f): f is string => Boolean(f && f.length > 10));
    let dekking = 1;
    if (fragmenten.length > 0) {
      const scores = fragmenten.map((f) => {
        const doel = f.split(/[\s-]+/).map(norm).filter((w) => w.length >= 3);
        if (doel.length === 0) return 1;
        return doel.filter((w) => inClip.has(w)).length / doel.length;
      });
      dekking = scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    // Per segment: vind de kop van zijn fragment terug in wat er klinkt.
    const perShot = segmenten
      .filter((sg) => sg.transcript_fragment && sg.transcript_fragment.length > 10)
      .map((sg) => {
        const idx = vindKopIndex(sg.transcript_fragment as string, woorden);
        return {
          volgorde: sg.volgorde,
          gevonden: idx !== null,
          opSeconde: idx !== null ? Math.round(woorden[idx].s * 10) / 10 : null,
        };
      });

    // Aanloop: zoek waar de eerste scriptzin begint in wat er werkelijk
    // klinkt. Alles daarvóór is meegenomen bronmateriaal dat het plan niet
    // vroeg. Kleine adempauzes zijn prima; hele woorden niet. Alleen de
    // eerste 30 woorden van de clip zijn relevant — dit gaat over het begín,
    // niet over de rest.
    let aanloop: ScriptOordeel['aanloop'] = null;
    const eersteFragment = fragmenten[0];
    if (eersteFragment) {
      const beginIndex = vindKopIndex(eersteFragment, woorden, 30) ?? -1;
      if (beginIndex > 0) {
        const seconden = woorden[beginIndex].s;
        if (seconden > 0.7) {
          aanloop = {
            seconden: Math.round(seconden * 100) / 100,
            tekst: woorden.slice(0, beginIndex).map((w) => w.w).join(' ').slice(0, 80),
          };
        }
      }
    }

    return { dekking, herhalingen, woorden: woorden.length, aanloop, perShot };
  } catch {
    return null;
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }
}
