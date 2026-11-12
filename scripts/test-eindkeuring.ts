/**
 * De eindkeuring: regels op het gerenderde bestand. Hier zonder video — de
 * meters zijn nagebootst; de ijking op echte clips staat bij de instellingen.
 */
import type { Shot } from '../src/lib/roughcut';
import { keurGeluid, keurHoofdHeel, keurHook, keurMensInBeeld, keurOndertitelsAanwezig, keurStaart, keurZwart, tijdlijnZonderMens, type BeeldUitslag } from '../src/lib/roughcut/eindkeuring';
import { keuringStatus, type KeuringRegel } from '../src/lib/roughcut/keuring';
import type { BronWoord } from '../src/lib/roughcut/woorden';

let geslaagd = 0;
let totaal = 0;
function toets(naam: string, ok: boolean, detail = '') {
  totaal++;
  if (ok) geslaagd++;
  console.log(`  ${ok ? '✓' : '✗'} ${naam}${ok || !detail ? '' : ` — ${detail}`}`);
}
const shot = (volgorde: number, start: number, end: number, extra: Partial<Shot> = {}): Shot => ({ volgorde, start, end, functie: 'setup', ...extra }) as Shot;
const woorden = (van: number, tot: number): BronWoord[] => {
  const uit: BronWoord[] = [];
  for (let t = van; t < tot - 0.3; t += 0.4) uit.push({ w: `w${Math.round(t * 10)}`, s: t, e: t + 0.3 });
  return uit;
};
/** Meter die op de opgegeven tijdvakken "niemand" meldt. */
const meter = (leeg: [number, number][], stuk = false) => async (tijden: number[]) => (stuk ? null : tijden.map((t) => !leeg.some(([a, b]) => t >= a && t <= b)));

async function main() {
  console.log('mens in beeld');
  {
    const goed = await keurMensInBeeld(28, meter([]));
    toets('overal een gezicht: goed', goed.goed === true, goed.detail);
    // De speakerkast: 0,9 s niemand in beeld midden in de clip.
    const kast = await keurMensInBeeld(28, meter([[24.0, 24.9]]));
    toets('0,9 s leeg kader: afgekeurd, met het tijdvak erbij', kast.goed === false && /24\.0 tot 25\.0/.test(kast.detail), kast.detail);
    // Eén gemist moment (lachen met de hand voor de mond) is geen fout.
    const los = await keurMensInBeeld(28, meter([[26.1, 26.2]]));
    toets('één los gemist moment: goed', los.goed === true, los.detail);
    // Een graphic hoort geen mens te tonen: dat stuk telt niet mee.
    const graphic = await keurMensInBeeld(33, meter([[0, 8.2]]), [[-0.3, 8.5]]);
    toets('graphic in de opening: daar wordt geen mens verwacht', graphic.goed === true, graphic.detail);
    const zonder = await keurMensInBeeld(33, meter([[0, 8.2]]));
    toets('zelfde beeld zonder dat het een graphic is: afgekeurd', zonder.goed === false, zonder.detail);
    const nergens = await keurMensInBeeld(20, meter([[0, 20]]));
    toets('nergens een gezicht: niet "goed" maar "bekijk de clip" (verplicht)', nergens.goed === null && nergens.verplicht === true, nergens.detail);
    const kapot = await keurMensInBeeld(20, meter([], true));
    toets('meting mislukt: verplicht, dus review', kapot.goed === null && keuringStatus([kapot, { naam: 'x', goed: true, detail: '' }]) === 'review_nodig');
  }

  console.log('hoofd heel in beeld');
  {
    const randMeter = (rand: [number, number][], kant: 'links' | 'rechts' = 'links') => async (tijden: number[]): Promise<BeeldUitslag[]> =>
      tijden.map((t) => (rand.some(([a, b]) => t >= a && t <= b) ? kant : true));
    toets('nergens tegen de rand: goed', (await keurHoofdHeel(28, randMeter([]))).goed === true);
    const half = await keurHoofdHeel(40, randMeter([[11.5, 12.2]]));
    toets('0,75 s tegen de linkerrand: afgekeurd met tijd en kant', half.goed === false && /linkerrand vanaf 11\.6/.test(half.detail), half.detail);
    toets('één los moment: goed', (await keurHoofdHeel(40, randMeter([[5.3, 5.4]]))).goed === true);
    // Een hoofd tegen de rand telt wél als "mens in beeld".
    toets('rand telt als mens in beeld', (await keurMensInBeeld(40, randMeter([[11.5, 12.2]]))).goed === true);
  }

  console.log('graphics op de tijdlijn');
  {
    const segs = [
      shot(1, 100, 108, { scenes: [{ van: 100, tot: 108, gezicht: false }] } as Partial<Shot>),
      shot(2, 108, 120, { scenes: [{ van: 108, tot: 120, gezicht: true }] } as Partial<Shot>),
    ];
    const z = tijdlijnZonderMens(segs, 'vullend');
    toets('graphic-deelstuk staat als "geen mens verwacht" op de tijdlijn', z.some(([a, b]) => a <= -0.3 + 1e-6 && b >= 8.3 - 1e-6) && z.every(([, b]) => b <= 8.3 + 1e-6), JSON.stringify(z));
  }

  console.log('geluid en zwart');
  {
    toets('-14 LUFS, piek -1,5: goed', keurGeluid({ lufs: -14.1, piek: -1.5 }).goed === true);
    toets('-20 LUFS: te zacht', keurGeluid({ lufs: -20, piek: -6 }).goed === false && /te zacht/.test(keurGeluid({ lufs: -20, piek: -6 }).detail));
    toets('-9 LUFS: te hard', keurGeluid({ lufs: -9, piek: -1 }).goed === false);
    toets('piek op 0 dBFS: vervormt', keurGeluid({ lufs: -14, piek: 0 }).goed === false);
    toets('niet te meten: verplicht', keurGeluid(null).goed === null && keurGeluid(null).verplicht === true);
    toets('geen zwart: goed', keurZwart([]).goed === true);
    toets('zwart stuk: afgekeurd met tijden', keurZwart([[3.2, 3.8]]).goed === false && /3\.2 tot 3\.8/.test(keurZwart([[3.2, 3.8]]).detail));
  }

  console.log('hook en einde');
  {
    const w = woorden(10.1, 30);
    toets('eerste woord na 0,1 s: goed', keurHook([shot(1, 10, 20)], w).goed === true);
    const laat = keurHook([shot(1, 9, 20)], w);
    toets('eerste woord pas na 1,1 s: afgekeurd', laat.goed === false && /1\.10 s/.test(laat.detail), laat.detail);
    toets('eerste shot zonder spraak: afgekeurd', keurHook([shot(1, 40, 45)], w).goed === false);
    toets('geen woorden: verplicht niet-getoetst', keurHook([shot(1, 10, 20)], null).goed === null && keurHook([shot(1, 10, 20)], null).verplicht === true);
    toets('stopt 0,3 s na het laatste woord: goed', keurStaart([shot(1, 10, 20.4)], woorden(10, 20.4)).goed === true);
    // Reactie na de punchline: een woordloos slotstuk van 2,5 s mag.
    toets('woordloze reactie van 2,5 s aan het einde: goed', keurStaart([shot(1, 10, 20), shot(2, 40, 42.5)], woorden(10, 20)).goed === true);
    const ijl = keurStaart([shot(1, 10, 20), shot(2, 40, 45)], woorden(10, 20));
    toets('5 s zonder woorden aan het einde: na-ijlen', ijl.goed === false, ijl.detail);
  }

  console.log('ondertitels en status');
  {
    toets('geen ondertitels terwijl ze verwacht worden: afgekeurd', keurOndertitelsAanwezig(null, true).goed === false && keurOndertitelsAanwezig(0, true).goed === false);
    toets('uitgezet voor de campagne: goed', keurOndertitelsAanwezig(null, false).goed === true);
    const regels: KeuringRegel[] = [{ naam: 'a', goed: true, detail: '' }, { naam: 'b', goed: null, detail: '' }];
    toets('niet-verplichte regel zonder meting: blijft goed', keuringStatus(regels) === 'goed');
    toets('verplichte regel zonder meting: review nodig', keuringStatus([...regels, { naam: 'c', goed: null, verplicht: true, detail: '' }]) === 'review_nodig');
  }

  console.log(`${geslaagd}/${totaal} geslaagd`);
  if (geslaagd !== totaal) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
