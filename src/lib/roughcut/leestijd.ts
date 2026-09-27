import { instelling } from './instellingen';
import { deelstukken } from './scenes';
import type { Kader } from './kader';
import type { KeuringRegel } from './keuring';
import type { Shot } from './index';
import type { Box } from './graphics';

/**
 * Leestijd voor graphics.
 *
 * De bron toont een graphic 1,5 tot 4 seconden, en de montage volgde dat één
 * op één — een cijfer als "< 3 maanden wereldwijde vraag" stond er te kort om
 * te lezen. Regel: elke graphic staat minstens zijn leestijd in beeld
 * (basis plus per woord of getal). Is het bronstuk korter, dan blijft het
 * laatste frame staan terwijl het geluid gewoon doorloopt, en begint het
 * beeld van het volgende deelstuk later — dat deelstuk wordt aan zijn begin
 * ingekort, zodat beeld en geluid overal op dezelfde brontijd blijven. Het
 * geluid schuift nooit.
 *
 * Grens: de spreker mag niet te lang onzichtbaar zijn. Volgt er een
 * punchline (een payoff- of barst-shot), dan is de graphic plus het
 * vasthouden hoogstens GRAPHIC_MAX_ONZICHTBAAR; en van het volgende
 * deelstuk blijft altijd iets over.
 */

export function leestijd(woorden: number | null | undefined): number {
  const w = woorden ?? instelling('GRAPHIC_LEES_TERUGVAL_WOORDEN');
  return Math.min(instelling('GRAPHIC_LEES_MAX'), instelling('GRAPHIC_LEES_BASIS') + instelling('GRAPHIC_LEES_PER_WOORD') * w);
}

export type LeesAanpassing = { vasthouden: number; inkorten: number };

export type LeesGraphic = {
  shot: number;
  deel: number;
  /** Plek op de tijdlijn (s). */
  start: number;
  duur: number;
  nodig: number;
  /** Wat er na vasthouden in beeld staat. */
  getoond: number;
  vasthouden: number;
  woorden: number | null;
  reden?: string;
  inhoud?: Box | null;
};

export type LeesPlan = {
  /** Per `${shotIndex}:${deelIndex}`. */
  aanpassing: Map<string, LeesAanpassing>;
  graphics: LeesGraphic[];
};

const isGraphic = (seg: Shot, d: { kader: Kader; gezicht: boolean | null }) =>
  d.kader === 'blur' && (d.gezicht === false || (d.gezicht === null && seg.beeldtype === 'graphic'));

/** Het plan voor een hele montage (segmenten in volgorde). Puur rekenwerk. */
export function leestijdPlan(segmenten: Shot[], kader: Kader): LeesPlan {
  type Stuk = { shot: number; deel: number; start: number; duur: number; graphic: boolean; woorden: number | null; functie: string; inhoud?: Box | null };
  const stukken: Stuk[] = [];
  let cursor = 0;
  segmenten.forEach((seg, i) => {
    deelstukken(seg, kader).forEach((d, k) => {
      stukken.push({
        shot: i,
        deel: k,
        start: cursor + d.van,
        duur: d.tot - d.van,
        graphic: isGraphic(seg, d),
        woorden: d.leeswoorden ?? null,
        functie: seg.functie,
        inhoud: d.inhoud,
      });
    });
    cursor += seg.end - seg.start;
  });

  const aanpassing = new Map<string, LeesAanpassing>();
  const zet = (s: Stuk, v: Partial<LeesAanpassing>) => {
    const sleutel = `${s.shot}:${s.deel}`;
    const oud = aanpassing.get(sleutel) ?? { vasthouden: 0, inkorten: 0 };
    aanpassing.set(sleutel, { vasthouden: v.vasthouden ?? oud.vasthouden, inkorten: v.inkorten ?? oud.inkorten });
  };
  const graphics: LeesGraphic[] = [];
  for (let j = 0; j < stukken.length; j++) {
    const g = stukken[j];
    if (!g.graphic) continue;
    const nodig = leestijd(g.woorden);
    let vasthouden = 0;
    let reden: string | undefined;
    if (g.duur < nodig - 0.05) {
      const volgende = stukken[j + 1];
      if (!volgende) reden = 'laatste beeld van de clip';
      else if (volgende.graphic) reden = 'gevolgd door een andere graphic';
      else {
        const punchline = volgende.functie === 'payoff' || volgende.functie === 'barst';
        const plafond = punchline
          ? Math.max(0, instelling('GRAPHIC_MAX_ONZICHTBAAR') - g.duur)
          : instelling('GRAPHIC_MAX_HOLD');
        const ruimte = Math.max(0, volgende.duur - instelling('GRAPHIC_MIN_REST'));
        vasthouden = Math.max(0, Math.min(nodig - g.duur, plafond, ruimte));
        vasthouden = Math.round(vasthouden * 100) / 100;
        if (vasthouden < nodig - g.duur - 0.05) {
          reden = punchline && plafond <= ruimte ? 'punchline volgt: spreker niet langer weg' : 'volgend deelstuk te kort';
        }
        if (vasthouden > 0) {
          zet(g, { vasthouden });
          zet(volgende, { inkorten: vasthouden });
        }
      }
    }
    graphics.push({
      shot: g.shot,
      deel: g.deel,
      start: g.start,
      duur: g.duur,
      nodig,
      getoond: g.duur + vasthouden,
      vasthouden,
      woorden: g.woorden,
      reden,
      inhoud: g.inhoud,
    });
  }
  return { aanpassing, graphics };
}

/** De graphic die op dit tijdlijnmoment vastgehouden in beeld staat (voor de ondertitelplek), of undefined. */
export function vastgehoudenOp(plan: LeesPlan, t: number): LeesGraphic | undefined {
  return plan.graphics.find((g) => g.vasthouden > 0 && t >= g.start + g.duur && t < g.start + g.getoond);
}

/** Eén regel voor de log. */
export function leesLogregel(plan: LeesPlan): string {
  const g = plan.graphics;
  if (g.length === 0) return 'leestijd: geen graphics';
  const verlengd = g.filter((x) => x.vasthouden > 0);
  const kort = g.filter((x) => x.getoond < x.nodig - 0.05);
  const n = (x: number) => x.toFixed(1).replace('.', ',');
  return (
    `leestijd: ${g.length} graphic(s), ${verlengd.length} verlengd` +
    (verlengd.length ? ` (${verlengd.map((x) => `+${n(x.vasthouden)} s → ${n(x.getoond)} s`).join(', ')})` : '') +
    (kort.length ? `, ${kort.length} korter dan de leestijd (${kort.map((x) => `${n(x.getoond)}/${n(x.nodig)} s: ${x.reden ?? '?'}`).join('; ')})` : ', alle leesbaar')
  );
}

/** Keuringsregel "graphics leesbaar": elke graphic minstens zijn leestijd in beeld, of een gegronde reden waarom niet. */
export function keurLeesbaar(segmenten: Shot[], kader: Kader): KeuringRegel {
  const plan = leestijdPlan(segmenten, kader);
  const naam = 'graphics leesbaar';
  if (plan.graphics.length === 0) return { naam, goed: true, detail: 'geen graphics in de clip' };
  const kort = plan.graphics.filter((x) => x.getoond < x.nodig - 0.05);
  // Een punchline die de spreker terug vraagt is een bewuste afweging, geen
  // fout; alle andere tekorten zijn review.
  const fout = kort.filter((x) => !(x.reden ?? '').startsWith('punchline'));
  const n = (x: number) => x.toFixed(1).replace('.', ',');
  return {
    naam,
    goed: fout.length === 0,
    detail:
      fout.length === 0
        ? `${plan.graphics.length} graphic(s), ${plan.graphics.filter((x) => x.vasthouden > 0).length} verlengd` +
          (kort.length ? `, ${kort.length} bewust korter (punchline volgt)` : '; allemaal minstens hun leestijd in beeld')
        : fout.map((x) => `graphic op ${n(x.start)} s: ${n(x.getoond)} s in beeld, leestijd ${n(x.nodig)} s (${x.reden ?? '?'})`).join('; '),
  };
}
