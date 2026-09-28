/**
 * Tests voor de ondertitelwoorden (src/lib/roughcut/ondertitelwoorden.ts):
 * het groter model alleen op de gebruikte bereiken (met cache, tijdsbudget en
 * terugval op 'small') en de correctiepas (streng 1-op-1, tijden behouden,
 * getallen onaangeroerd). Transcriptie, cache en de modelcall zijn gestubd.
 *
 * Draaien: npm run test:ondertitelwoorden
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { corrigeerWoorden, pasCorrectiesToe, verfijnWoorden, type WoordCache } from '../src/lib/roughcut/ondertitelwoorden';
import type { BronWoord } from '../src/lib/roughcut/woorden';

let gefaald = 0;
let gedaan = 0;
function toets(naam: string, voorwaarde: boolean, detail = '') {
  gedaan++;
  if (voorwaarde) console.log(`  ✓ ${naam}`);
  else {
    gefaald++;
    console.log(`  ✗ ${naam}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const map = mkdtempSync(join(tmpdir(), 'clipper-otw-test-'));
  try {
    const bron = join(map, 'bron.mp4');
    spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=60', '-c:a', 'aac', bron]);

    // Hele-video-woorden ('small'): elke 0,5 s een woord, met één fout.
    const small: BronWoord[] = Array.from({ length: 120 }, (_, i) => ({ w: i === 25 ? 'enimetaal' : `klein${i}`, s: i * 0.5, e: i * 0.5 + 0.4 }));
    const segmenten = [{ start: 10, end: 16 }];
    const geheugen = new Map<string, BronWoord[]>();
    const cache: WoordCache = { lees: async (k) => geheugen.get(k) ?? null, schrijf: async (k, w) => void geheugen.set(k, w) };
    let aanroepen = 0;
    // Het "grote model": geeft relatief aan het bereik goede woorden terug.
    const groot = async (_wav: string, model: string) => {
      aanroepen++;
      return Array.from({ length: 16 }, (_, i) => ({ w: i === 7 ? 'edelmetaal' : `groot${i}`, s: i * 0.5, e: i * 0.5 + 0.4 }));
    };

    console.log('groter model op de gebruikte bereiken');
    const v = await verfijnWoorden({ videoId: 'test', bronPad: bron, segmenten, bronWoorden: small, model: 'large-v3-turbo', transcribeer: groot, cache });
    toets('één bereik (segment + 1 s marge)', v.bereiken.length === 1 && v.bereiken[0].van === 9 && v.bereiken[0].tot === 17, JSON.stringify(v.bereiken));
    toets('nieuw getranscribeerd met het grote model', v.bereiken[0].bron === 'nieuw' && v.bereiken[0].model === 'large-v3-turbo');
    const midden = v.woorden.filter((w) => w.s >= 10 && w.e <= 16);
    toets('binnen het bereik de woorden van het grote model', midden.length > 0 && midden.every((w) => w.w.startsWith('groot') || w.w === 'edelmetaal'), midden.map((w) => w.w).join(' '));
    toets('met de juiste brontijd (bereikstart opgeteld)', midden.some((w) => w.w === 'edelmetaal' && Math.abs(w.s - 12.5) < 0.01), JSON.stringify(midden.find((w) => w.w === 'edelmetaal')));
    toets('buiten het bereik de oude woorden', v.woorden.some((w) => w.w === 'klein0') && v.woorden.some((w) => w.w === 'klein100'));
    toets('woorden op tijdvolgorde', v.woorden.every((w, i) => i === 0 || w.s >= v.woorden[i - 1].s));
    toets('in de cache gezet', geheugen.size === 1);

    const v2 = await verfijnWoorden({ videoId: 'test', bronPad: bron, segmenten, bronWoorden: small, model: 'large-v3-turbo', transcribeer: groot, cache });
    toets('tweede keer uit de cache, geen nieuwe transcriptie', aanroepen === 1 && v2.bereiken[0].bron === 'cache');

    const faalt = async () => {
      throw new Error('time-out na 150 s');
    };
    const v3 = await verfijnWoorden({ videoId: 'test2', bronPad: bron, segmenten, bronWoorden: small, model: 'large-v3-turbo', transcribeer: faalt, cache });
    toets('time-out → terugval op small, woorden ongewijzigd', v3.bereiken[0].bron === 'terugval' && v3.woorden.length === small.length && v3.woorden[25].w === 'enimetaal', JSON.stringify(v3.bereiken));
    const v4 = await verfijnWoorden({ videoId: 'test3', bronPad: bron, segmenten, bronWoorden: small, transcribeer: groot, cache, budgetSeconden: 1 });
    toets('tijdsbudget op → niet eens beginnen, terugval', v4.bereiken[0].bron === 'terugval' && /budget/.test(v4.bereiken[0].reden ?? ''), JSON.stringify(v4.bereiken));

    console.log('correctiepas');
    const woorden: BronWoord[] = [
      { w: 'Goud', s: 1, e: 1.3 }, { w: 'is', s: 1.3, e: 1.4 }, { w: 'een', s: 1.4, e: 1.5 }, { w: 'enimetaal,', s: 1.5, e: 2.1 },
      { w: 'maar', s: 2.2, e: 2.4 }, { w: 'platen', s: 2.5, e: 2.9 }, { w: '2920', s: 3, e: 3.5 }, { w: 'dollar.', s: 3.5, e: 3.9 },
    ];
    const toegepast = pasCorrectiesToe(woorden, [
      { index: 3, woord: 'edelmetaal' },
      { index: 5, woord: 'platina' },
      { index: 6, woord: '2.920' }, // getal: niet aankomen
      { index: 1, woord: 'is namelijk' }, // twee woorden: geen herschrijven
      { index: 99, woord: 'x' },
      { index: 2, woord: 'een' }, // geen wijziging
    ]);
    toets('herkenningsfouten gecorrigeerd', toegepast.woorden[3].w === 'edelmetaal,' && toegepast.woorden[5].w === 'platina', JSON.stringify(toegepast.woorden.map((w) => w.w)));
    toets('leesteken van het origineel blijft', toegepast.woorden[3].w.endsWith(','));
    toets('getallen niet veranderd', toegepast.woorden[6].w === '2920');
    toets('geen herschrijving naar meerdere woorden', toegepast.woorden[1].w === 'is');
    toets('tijden exact behouden', toegepast.woorden.every((w, i) => w.s === woorden[i].s && w.e === woorden[i].e));
    toets('twee correcties gelogd', toegepast.toegepast.length === 2 && toegepast.toegepast[0].van === 'enimetaal' && toegepast.toegepast[0].naar === 'edelmetaal', JSON.stringify(toegepast.toegepast));

    let prompt = '';
    const c = await corrigeerWoorden(woorden, { titel: 'Platina', campagne: 'GoldRepublic', namen: ['Sanne'] }, async (_s, u) => {
      prompt = u;
      return { correcties: [{ index: 3, woord: 'edelmetaal' }] };
    });
    toets('call krijgt genummerde woorden en context', /3:enimetaal/.test(prompt) && /GoldRepublic/.test(prompt) && /Sanne/.test(prompt), prompt.slice(0, 200));
    toets('resultaat van de call toegepast', c.woorden[3].w === 'edelmetaal,' && c.toegepast.length === 1);
    const mis = await corrigeerWoorden(woorden, {}, async () => {
      throw new Error('limiet');
    });
    toets('mislukte call: ongecorrigeerd door, met melding', mis.woorden[3].w === 'enimetaal,' && mis.fout === 'limiet');
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
