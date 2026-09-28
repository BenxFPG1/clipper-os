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
  /**
   * Wanneer deze graphic werkelijk in beeld komt (tijdlijn). In een blok
   * schuiven de latere graphics op met het vasthouden van de eerdere.
   */
  beeldStart: number;
  /** Aantal graphics in het blok waar deze bij hoort (1 = losse graphic). */
  blok: number;
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
  type Stuk = { shot: number; deel: number; start: number; duur: number; graphic: boolean; woorden: number | null; functie: string; inhoud?: Box | null; houdbaar: boolean; geenBevries?: string; herkomst: string };
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
        geenBevries: d.geenBevries,
        // Waar dit stuk vandaan komt, voor de logregel: zonder dit was niet te
        // zien waaróm een graphic geen vasthoudframe had.
        herkomst:
          `shot ${seg.volgorde} bron ${(seg.start + d.van).toFixed(1)}–${(seg.start + d.tot).toFixed(1)} s, ` +
          (seg.scenes?.length ? `scène (gezicht ${d.gezicht})` : `heel shot (beeldtype ${seg.beeldtype ?? '—'})`),
        // Alleen vasthouden met een gemeten graphic-frame binnen dit stuk.
        // Zonder dat viel de render terug op het laatste frame van het stuk,
        // en dat lag bij een overgang al in het camerabeeld: de spreker stond
        // dan bevroren als postzegel in het passende kader (PLATINA clip 1).
        // Ook een heel shot dat de beeldcontrole als graphic zag, wordt niet
        // verlengd zonder gemeten, stilstaand graphic-frame: zo'n shot was in
        // PLATINA clip 1 een 1,3 s lange sectietitel-overgang.
        houdbaar: d.bevries !== undefined && d.bevries - seg.start >= d.van && d.bevries - seg.start <= d.tot,
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
  // Graphics die direct op elkaar volgen vormen een blok: er zit geen spreker
  // tussen om van te lenen. Elke graphic in het blok krijgt zijn tekort als
  // vasthouden (daardoor komen de volgende graphics later in beeld), en het
  // eerste spreker-deelstuk ná het blok levert de som in — alleen beeld, het
  // geluid schuift niet. Het beeld loopt in het blok dus tijdelijk achter op
  // het geluid; dat is de bewuste afweging tegen onleesbare graphics.
  for (let j = 0; j < stukken.length; j++) {
    if (!stukken[j].graphic) continue;
    let eind = j;
    while (eind + 1 < stukken.length && stukken[eind + 1].graphic) eind++;
    const blok = stukken.slice(j, eind + 1);
    const volgende = stukken[eind + 1];
    j = eind;

    // Per graphic het tekort; een flits (korter dan GRAPHIC_MIN_VOOR_LEESTIJD)
    // is een overgang, geen leesmoment, en telt niet mee.
    const tekorten = blok.map((g) => {
      if (g.duur < instelling('GRAPHIC_MIN_VOOR_LEESTIJD')) return { g, nodig: 0, tekort: 0, telt: false, reden: undefined as string | undefined };
      const nodig = leestijd(g.woorden);
      const tekort = Math.max(0, nodig - g.duur);
      return { g, nodig, tekort: tekort > 0.05 ? tekort : 0, telt: true, reden: undefined as string | undefined };
    });
    for (const t of tekorten) if (t.tekort > 0 && !t.g.houdbaar) {
      t.reden = `geen gemeten graphic-frame om vast te houden${t.g.geenBevries ? `: ${t.g.geenBevries}` : ''} [${t.g.herkomst}]`;
      t.tekort = 0;
      (t as { geenFrame?: boolean }).geenFrame = true;
    }
    const som = tekorten.reduce((a, t) => a + t.tekort, 0);

    let budget = 0;
    let beperking: string | undefined;
    if (som > 0) {
      if (!volgende) beperking = 'laatste beeld van de clip';
      else {
        const blokDuur = blok.reduce((a, g) => a + g.duur, 0);
        const punchline = volgende.functie === 'payoff' || volgende.functie === 'barst';
        const plafond = punchline
          ? Math.max(0, instelling('GRAPHIC_MAX_ONZICHTBAAR') - blokDuur)
          : blok.length > 1
            ? instelling('GRAPHIC_MAX_BLOK_VERTRAGING')
            : instelling('GRAPHIC_MAX_HOLD');
        const ruimte = Math.max(0, volgende.duur - instelling('GRAPHIC_MIN_REST'));
        budget = Math.min(som, plafond, ruimte);
        if (budget < som - 0.05) {
          beperking =
            ruimte < plafond
              ? 'volgend deelstuk te kort'
              : punchline
                ? 'punchline volgt: spreker niet langer weg'
                : blok.length > 1
                  ? 'blok: vertraging begrensd'
                  : 'vasthouden begrensd';
        }
      }
    }
    // Past het niet, dan naar rato van het tekort verdeeld.
    const factor = som > 0 ? budget / som : 0;
    let totaal = 0;
    let vertraging = 0;
    for (const t of tekorten) {
      const vasthouden = Math.round(t.tekort * factor * 100) / 100;
      if (vasthouden > 0) {
        zet(t.g, { vasthouden });
        totaal += vasthouden;
      }
      if (t.telt) {
        const getoond = t.g.duur + vasthouden;
        graphics.push({
          shot: t.g.shot,
          deel: t.g.deel,
          start: t.g.start,
          duur: t.g.duur,
          nodig: t.nodig,
          getoond,
          vasthouden,
          woorden: t.g.woorden,
          reden: getoond < t.nodig - 0.05 ? t.reden ?? beperking ?? (blok.length > 1 ? 'gevolgd door een andere graphic' : undefined) : undefined,
          inhoud: t.g.inhoud,
          beeldStart: t.g.start + vertraging,
          blok: blok.length,
        });
      }
      vertraging += vasthouden;
    }
    if (totaal > 0 && volgende) zet(volgende, { inkorten: Math.round(totaal * 100) / 100 });
  }
  return { aanpassing, graphics };
}

/** De graphic die op dit tijdlijnmoment vastgehouden in beeld staat (voor de ondertitelplek), of undefined. */
export function vastgehoudenOp(plan: LeesPlan, t: number): LeesGraphic | undefined {
  // Alles wat in beeld staat op een ander moment dan zijn eigen tijdlijnplek:
  // het vastgehouden stuk, en in een blok de opgeschoven latere graphics.
  return plan.graphics.find(
    (g) => (g.vasthouden > 0 || g.beeldStart > g.start + 0.01) && t >= g.beeldStart && t < g.beeldStart + g.getoond,
  );
}

/** Eén regel voor de log. */
export function leesLogregel(plan: LeesPlan): string {
  const g = plan.graphics;
  if (g.length === 0) return 'leestijd: geen graphics';
  const verlengd = g.filter((x) => x.vasthouden > 0);
  const kort = g.filter((x) => x.getoond < x.nodig - 0.05);
  const n = (x: number) => x.toFixed(1).replace('.', ',');
  return (
    `leestijd: ${g.length} graphic(s)${g.some((x) => x.blok > 1) ? ` (blok van ${Math.max(...g.map((x) => x.blok))})` : ''}, ${verlengd.length} verlengd` +
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
  // Ook een begrensde blokvertraging is een bewuste keuze: het beeld loopt
  // dan al tot drie seconden achter op het geluid.
  const bewust = (r?: string) => /^(punchline|blok: vertraging begrensd|vasthouden begrensd)/.test(r ?? '');
  // De leestijd is een ruime bovengrens (tot 4 s); een graphic die er
  // minstens 80% van krijgt is leesbaar. Alleen daaronder is het een fout.
  // (PLATINA clip 3: drie graphics op 3,2–3,4 van 4,0 s, beperkt doordat de
  // spreker erna niet meer kon inleveren — goed te lezen.)
  const genoeg = (x: { getoond: number; nodig: number }) => x.getoond >= instelling('GRAPHIC_LEES_GENOEG') * x.nodig;
  const fout = kort.filter((x) => !bewust(x.reden) && !genoeg(x));
  const n = (x: number) => x.toFixed(1).replace('.', ',');
  return {
    naam,
    goed: fout.length === 0,
    detail:
      fout.length === 0
        ? `${plan.graphics.length} graphic(s), ${plan.graphics.filter((x) => x.vasthouden > 0).length} verlengd` +
          (kort.length ? `, ${kort.length} bewust korter (punchline volgt of vertraging begrensd)` : '; allemaal minstens hun leestijd in beeld')
        : fout.map((x) => `graphic op ${n(x.start)} s: ${n(x.getoond)} s in beeld, leestijd ${n(x.nodig)} s (${x.reden ?? '?'})`).join('; '),
  };
}
