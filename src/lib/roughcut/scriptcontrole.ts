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

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

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
    // Zelfde meetbug als bij de aanloop-detectie hieronder, en hier: een
    // fragment dat begint met een kort woordje ("en dat is Platina") werd
    // stelselmatig gemist, omdat de kandidatenlijst woorden onder de 3
    // letters wegfiltert — en dus precies de eigen openingswoorden niet
    // herkent. Eerst een exacte match op de eerste twee woorden proberen
    // (zonder lengte-ondergrens); de oude, ruimere heuristiek blijft de
    // terugval voor als whisper het allereerste woord anders hoorde.
    const zoekKop = (fragment: string): number | null => {
      const kopRuw = fragment.split(/[\s-]+/).map(norm).filter(Boolean);
      if (kopRuw[0] && kopRuw[1]) {
        for (let i = 0; i < woorden.length; i++) {
          if (woorden[i].n === kopRuw[0] && woorden[i + 1]?.n === kopRuw[1]) return i;
        }
      }
      const kop = fragment.split(/[\s-]+/).map(norm).filter((w) => w.length >= 3).slice(0, 5);
      for (let i = 0; i < woorden.length; i++) {
        if (kop.includes(woorden[i].n) && (kop.includes(woorden[i + 1]?.n) || kop.includes(woorden[i + 2]?.n))) {
          return i;
        }
      }
      return null;
    };
    const perShot = segmenten
      .filter((sg) => sg.transcript_fragment && sg.transcript_fragment.length > 10)
      .map((sg) => {
        const idx = zoekKop(sg.transcript_fragment as string);
        return {
          volgorde: sg.volgorde,
          gevonden: idx !== null,
          opSeconde: idx !== null ? Math.round(woorden[idx].s * 10) / 10 : null,
        };
      });

    // Aanloop: zoek waar de eerste scriptzin begint in wat er werkelijk
    // klinkt. Alles daarvóór is meegenomen bronmateriaal dat het plan niet
    // vroeg. Kleine adempauzes zijn prima; hele woorden niet.
    let aanloop: ScriptOordeel['aanloop'] = null;
    const eersteFragment = fragmenten[0];
    if (eersteFragment) {
      let beginIndex = -1;

      // Sterkste bewijs eerst: de eerste twee woorden van het fragment zélf,
      // zónder de drieletter-ondergrens. Nederlandse zinnen beginnen bijna
      // altijd met een kort woordje ("en", "is", "er", "het") — dat woordje
      // hoort bij de zin, niet bij de aanloop. Met alleen 3+ letters in de
      // kandidatenlijst (zie hieronder) sloeg de zoektocht die korte
      // woordjes stelselmatig over en vond hij het "bewijs" pas bij het
      // eerste lange woord erna — waarmee de eigen, correcte openingswoorden
      // van de zin zelf als ongewenste aanloop werden aangemerkt. Precies
      // dát verklaarde waarom een clip die exact op zijn scripttekst begon
      // ("En dan is er nog het waterstofverhaal") toch als "aanloop: En dan
      // is er" werd afgekeurd.
      const kopRuw = eersteFragment.split(/[\s-]+/).map(norm).filter(Boolean);
      if (kopRuw[0] && kopRuw[1]) {
        for (let i = 0; i < Math.min(woorden.length, 30) && beginIndex < 0; i++) {
          if (woorden[i].n === kopRuw[0] && woorden[i + 1]?.n === kopRuw[1]) beginIndex = i;
        }
      }

      // Terugval op het oude, ruimere patroon (2 van de eerste woorden van
      // 3+ letters ergens dicht bij elkaar) — voor als whisper het allereerste
      // woord van de zin anders hoorde en de exacte match hierboven mist.
      if (beginIndex < 0) {
        const kop = eersteFragment.split(/[\s-]+/).map(norm).filter((w) => w.length >= 3).slice(0, 5);
        for (let i = 0; i < Math.min(woorden.length, 30) && beginIndex < 0; i++) {
          // Twee opeenvolgende kopwoorden is genoeg bewijs; transcriptie mist er
          // altijd wel een.
          const hit = kop.includes(woorden[i].n) && (kop.includes(woorden[i + 1]?.n) || kop.includes(woorden[i + 2]?.n));
          if (hit) beginIndex = i;
        }
      }

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
