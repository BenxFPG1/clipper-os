import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import type { Shot } from './index';

type Woord = { w: string; s: number; e: number };

/**
 * Lijnt knippunten uit op het gecíteerde fragment in plaats van op de
 * dichtstbijzijnde stilte.
 *
 * Waarom: de tijdcodes uit het plan zijn seconden-grof (YouTube-ondertitels
 * rollen in blokken van ~7s), en met een spraakpauze elke ~1,6 seconde grijpt
 * "dichtstbijzijnde stilte" regelmatig de verkeerde zinsgrens — dan begint een
 * shot een zin te vroeg of stopt hij te laat. Het plan wéét echter welke
 * woorden het wil: transcript_fragment. Dus transcriberen we per shot een
 * klein venster om de geplande tijden heen mét woordtijden, zoeken het begin
 * en einde van het citaat, en knippen exact daar.
 *
 * Werkt met faster-whisper (runner) of whisper-cli (Mac); zonder beide blijft
 * alles zoals het was. Het uitlijnmodel is bewust klein ('base'): we hoeven de
 * tekst niet perfect te verstaan, alleen bekende woorden terug te vinden.
 */
export async function lijnShotsUit(
  bronPad: string,
  shots: (Shot & { transcript_fragment?: string })[],
  opties: { marge?: number; model?: string; log?: (m: string) => void } = {},
): Promise<{ shots: Shot[]; uitgelijnd: number; woordgrenzen: number[] }> {
  const marge = opties.marge ?? 4;
  const model = opties.model ?? process.env.WHISPER_ALIGN_MODEL ?? 'base';
  const log = opties.log ?? (() => {});

  const werkmap = await mkdtemp(join(tmpdir(), 'clipper-align-'));
  let uitgelijnd = 0;

  // Alle woordgrenzen die we onderweg tegenkomen bewaren we. Praat iemand
  // onafgebroken door, dan is er geen stilte om op te knippen — maar de ruimte
  // tússen twee woorden is er altijd. Daar knippen klinkt schoon; middenin een
  // woord klinkt kapot.
  const woordgrenzen: number[] = [];

  try {
    const uit: Shot[] = [];
    for (const shot of shots) {
      const fragment = shot.transcript_fragment?.trim();
      if (!fragment || fragment.length < 12) {
        uit.push(shot);
        continue;
      }

      const spanStart = Math.max(0, shot.start - marge);
      const spanDuur = shot.end - shot.start + marge * 2;

      const wav = join(werkmap, `span-${shot.volgorde}.wav`);
      try {
        await run(resolveBinary('ffmpeg'), [
          // -nostdin: zonder blokkeert ffmpeg op zijn interactieve invoer als
          // hij als kindproces draait — de run hing er 17 minuten op.
          '-nostdin', '-y', '-ss', spanStart.toFixed(3), '-t', spanDuur.toFixed(3),
          '-i', bronPad, '-vn', '-ac', '1', '-ar', '16000', wav,
        ]);
        const woorden = await woordenVanFragment(wav, model);
        if (woorden.length < 4) {
          uit.push(shot);
          continue;
        }

        for (const w of woorden) {
          woordgrenzen.push(spanStart + w.s, spanStart + w.e);
        }

        const grenzen = zoekCitaat(woorden, fragment);
        if (!grenzen || (grenzen.start === null && grenzen.end === null)) {
          uit.push(shot);
          continue;
        }

        // Ook een halve match is winst: alleen het begin of alleen het einde
        // op het woord leggen is beter dan allebei laten gokken.
        uitgelijnd += 1;
        const nieuwStart =
          grenzen.start !== null ? Math.max(0, spanStart + grenzen.start - 0.06) : shot.start;
        const nieuwEind = grenzen.end !== null ? spanStart + grenzen.end + 0.15 : shot.end;
        if (nieuwEind - nieuwStart < 0.5) {
          uit.push(shot);
          continue;
        }
        uit.push({ ...shot, start: nieuwStart, end: nieuwEind });
      } catch {
        uit.push(shot);
      } finally {
        await rm(wav, { force: true });
      }
    }

    if (uitgelijnd > 0) log(`citaat-uitlijning: ${uitgelijnd}/${shots.length} shots op woordniveau`);
    return { shots: uit, uitgelijnd, woordgrenzen: [...new Set(woordgrenzen)].sort((a, b) => a - b) };
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }
}

/** Vind het begin van de eerste ~6 en het einde van de laatste ~6 citaatwoorden. */
function zoekCitaat(
  woorden: Woord[],
  fragment: string,
): { start: number | null; end: number | null } | null {
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const doel = fragment.split(/\s+/).map(norm).filter((w) => w.length >= 2);
  if (doel.length < 3) return null;

  const gehoord = woorden.map((w) => norm(w.w));
  const kop = doel.slice(0, Math.min(6, doel.length));
  const staart = doel.slice(-Math.min(6, doel.length));

  const vindReeks = (zoek: string[], vanIndex: number): { index: number; score: number } | null => {
    let beste: { index: number; score: number } | null = null;
    for (let i = vanIndex; i <= gehoord.length - Math.min(2, zoek.length); i++) {
      let score = 0;
      for (let j = 0; j < zoek.length && i + j < gehoord.length; j++) {
        if (gehoord[i + j] === zoek[j] || (zoek[j].length > 4 && gehoord[i + j].includes(zoek[j].slice(0, 4)))) {
          score += 1;
        }
      }
      if (!beste || score > beste.score) beste = { index: i, score };
    }
    return beste;
  };

  const begin = vindReeks(kop, 0);
  const beginOk = begin && begin.score >= Math.ceil(kop.length * 0.5);

  const eind = vindReeks(staart, beginOk ? begin.index : 0);
  const eindOk = eind && eind.score >= Math.ceil(staart.length * 0.5);

  if (!beginOk && !eindOk) return null;

  const start = beginOk ? woorden[begin.index].s : null;
  const laatsteWoord = eindOk ? Math.min(eind.index + staart.length - 1, woorden.length - 1) : -1;
  const end = eindOk ? woorden[laatsteWoord].e : null;
  if (start !== null && end !== null && end <= start) return null;
  return { start, end };
}

/** Woordtijden via faster-whisper (python), met whisper-cli als terugval. */
async function woordenVanFragment(wav: string, model: string): Promise<Woord[]> {
  // 1. Python/faster-whisper (staat op de runner).
  try {
    const uit = await run('python3', ['scripts/align.py', wav, model]);
    const woorden = JSON.parse(uit.trim().split('\n').pop() ?? '[]') as Woord[];
    if (woorden.length > 0) return woorden;
  } catch {
    // door naar whisper-cli
  }

  // 2. whisper-cli met tokens van maximaal één woord (Mac).
  const basis = `${wav}.uitlijn`;
  const modelPad = join(process.env.HOME ?? tmpdir(), '.cache', 'whisper-cpp', `ggml-${model}.bin`);
  try {
    await stat(modelPad);
  } catch {
    const res = await fetch(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`);
    if (!res.ok) throw new Error(`uitlijnmodel ${model} niet op te halen`);
    await writeFile(modelPad, Buffer.from(await res.arrayBuffer()));
  }
  await run(resolveBinary('whisper-cli'), ['-m', modelPad, '-l', 'nl', '-oj', '-of', basis, '-ml', '1', '-sow', '-nt', wav]);
  const json = JSON.parse(await readFile(`${basis}.json`, 'utf8')) as {
    transcription?: { offsets?: { from: number; to: number }; text: string }[];
  };
  await rm(`${basis}.json`, { force: true });
  return (json.transcription ?? [])
    .map((t) => ({ w: t.text.trim(), s: (t.offsets?.from ?? 0) / 1000, e: (t.offsets?.to ?? 0) / 1000 }))
    .filter((w) => w.w.length > 0);
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const kind = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    kind.stdout.on('data', (d) => (stdout += d));
    kind.stderr.on('data', (d) => (stderr += d));
    kind.on('error', reject);
    kind.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exit ${code}: ${stderr.slice(-200)}`)),
    );
  });
}
