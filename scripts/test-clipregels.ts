/**
 * Tests voor de inhoudsregels per clip (src/lib/planner/clipregels.ts) en
 * wat de planner en de retentie-editor ermee doen: lengte per format, één
 * verhaal, einde = moment, opening zonder context-gat, comedy-tempo en de
 * score. Puur rekenwerk op verzonnen plannen, zonder netwerk of model.
 *
 * Draaien: npm run test:clipregels
 */
import {
  clipDuur,
  formaatVoorThema,
  herhaaldeZinnen,
  isAfsluiter,
  maxSprongen,
  knipSlot,
  lengteBereik,
  pasClipRegelsToe,
  pasPlanRegelsToe,
  regelsVoorPrompt,
  sprongen,
  tweeVerhalen,
  wijstTerug,
  crossClipCheck,
  regelOvertredingen,
} from '../src/lib/planner/clipregels';
import { metPlafond, pasVerhaaldokterToe, planRoute } from '../src/lib/planner';
import { selectieSystem, uitschrijfOpdracht } from '../src/lib/planner/prompts';
import { selectieSchema } from '../src/lib/planner/schema';
import { planExamenSystem, schetsSystem, verhaaldokterSystem } from '../src/lib/planner/prompts';
import { PROMPT_VERSION_PLAN, verhaaldokterDiffSchema, type Clip } from '../src/lib/planner/schema';
import { pasRetentieToe } from '../src/lib/roughcut/retentie';
import { STANDAARD_DOELEN } from '../src/lib/vault/normen';
import type { Shot } from '../src/lib/roughcut';
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

type S = Clip['shots'][number];
const shot = (volgorde: number, start: number, end: number, functie: S['functie'], tekst: string): S => ({
  volgorde,
  start,
  end,
  functie,
  transcript_fragment: tekst,
  edit_notitie: '',
});

function clip(shots: S[], extra: Partial<Clip> = {}): Clip {
  return {
    titel_intern: 'test',
    structure_type: 'x',
    prioriteit: 1,
    verwachte_sterkte: 'hoog',
    score: 8,
    verhaallijn: {
      belofte: 'Platina is niet goud en dat kost beleggers geld',
      open_vraag: 'Waarom is platina goedkoper dan goud?',
      escalatie: ['de prijs daalde', 'maar de vraag stijgt'],
      payoff: 'Platina is zeldzamer dan goud en toch goedkoper',
      omslag: 'Je denkt dat goedkoper slechter is, maar het is juist de kans',
    },
    hook: { type: 'h', tekst_overlay: 'Platina is niet goud.', gesproken_start: '' },
    hooks: [],
    context_kaart: null,
    shots,
    caption: { tiktok: '?', reels: '?', shorts: '?' },
    verplichte_elementen: [],
    varianten: [],
    risico: 'geen',
    waarom_dit_werkt: '',
    ...extra,
  } as Clip;
}

async function main() {
  console.log('format per thema');
  {
    toets('comedy-thema → comedy', formaatVoorThema('comedy') === 'comedy' && formaatVoorThema('Entertainment') === 'comedy');
    toets('finance → uitleg', formaatVoorThema('finance') === 'uitleg' && formaatVoorThema('beleggen') === 'uitleg');
    toets('podcast/onbekend → interview', formaatVoorThema('podcast') === 'interview' && formaatVoorThema(null) === 'interview');
    toets('zonder thema: campagne + titel beslissen (PLATINA → uitleg)', formaatVoorThema(null, 'Campagne: GoldRepublic Waarom PLATINA ineens weer belangrijk is') === 'uitleg' && formaatVoorThema('all', 'GoldRepublic PLATINA') === 'uitleg');
    toets('bereiken: comedy 15–35, interview 20–45, uitleg 25–50', JSON.stringify([lengteBereik('comedy'), lengteBereik('interview'), lengteBereik('uitleg')]) === JSON.stringify([{ min: 15, max: 35 }, { min: 20, max: 45 }, { min: 25, max: 50 }]));
  }

  console.log('generieke afsluiters');
  {
    for (const z of ['Ik ben benieuwd wat jij hiervan vindt.', 'Laat het weten in de comments!', 'Like en abonneer.', 'Tot de volgende keer!', 'Dus ja.', 'Dat was het.', 'Bedankt voor het kijken.']) {
      toets(`afsluiter: "${z}"`, isAfsluiter(z));
    }
    for (const z of ['Platina is niet goud. En dat is het punt.', 'Ja, ligt aan de gelegenheid.', '5.250.000 euro en die ziet er zo uit.', 'Dat is het punt.', 'Camera, actie!']) {
      toets(`geen afsluiter: "${z}"`, !isAfsluiter(z));
    }
  }

  console.log('einde = moment');
  {
    // Platina 1: de payoff eindigt op een vraag aan de kijker.
    const c = clip([
      shot(1, 10, 14, 'hook', 'Platina is niet goud.'),
      shot(2, 20, 30, 'escalatie', 'De prijs van platina daalde terwijl goud steeg, en beleggers snapten er niets van.'),
      shot(3, 40, 52, 'payoff', 'Platina is zeldzamer dan goud en toch goedkoper. Dat is de kans. Ik ben benieuwd wat jij hiervan vindt.'),
    ]);
    const { clip: uit, oordeel } = pasClipRegelsToe(c, 'uitleg');
    const laatste = uit.shots[uit.shots.length - 1];
    toets('vraag aan de kijker geknipt', !/benieuwd/.test(laatste.transcript_fragment) && laatste.transcript_fragment.endsWith('Dat is de kans.'), laatste.transcript_fragment);
    toets('eindtijd evenredig naar voren', laatste.end < 52 && laatste.end > 46, String(laatste.end));
    toets('ingreep gelogd', oordeel.ingrepen.some((i) => /slotzin geknipt/.test(i)));

    // Nazinnetje ná de payoff in een eigen shot; een echte button blijft.
    const na = clip([
      shot(1, 10, 14, 'hook', 'Platina is niet goud.'),
      shot(2, 40, 50, 'payoff', 'Platina is zeldzamer dan goud en toch goedkoper.'),
      shot(3, 50, 56, 'setup', 'Dus het wordt in de toekomst misschien wel minder voorspelbaar.'),
    ]);
    const r = pasClipRegelsToe(na, 'uitleg');
    toets('afzwakkend nazinnetje na de payoff weggehaald', r.clip.shots.length === 2 && r.clip.shots[1].functie === 'payoff', JSON.stringify(r.oordeel.ingrepen));
    const knop = clip([
      shot(1, 10, 14, 'hook', 'Platina is niet goud.'),
      shot(2, 40, 50, 'payoff', 'Platina is zeldzamer dan goud.'),
      shot(3, 50, 51.2, 'button', 'En toch koop jij goud.'),
    ]);
    toets('echte button (tweede punchline) blijft', pasClipRegelsToe(knop, 'uitleg').clip.shots.length === 3);
    const zonder = clip([shot(1, 10, 14, 'hook', 'Platina is niet goud.'), shot(2, 20, 30, 'escalatie', 'De prijs daalde jarenlang.')]);
    const z = pasClipRegelsToe(zonder, 'uitleg');
    toets('geen payoff: harde fout', z.oordeel.fouten.some((f) => /geen payoff/.test(f)));
  }

  console.log('opening zonder context-gat');
  {
    const c = clip([
      shot(1, 100, 108, 'setup', 'En dan Scar japt hem, toch? Scar is de broer van Mufasa in de Lion King. Hij speelt hem al twintig jaar.'),
      shot(2, 110, 118, 'payoff', 'Hij doet de stem van Scar beter dan de film zelf.'),
    ]);
    const { clip: uit, oordeel } = pasClipRegelsToe(c, 'comedy');
    toets('instappunt naar de eerste begrijpelijke zin', uit.shots[0].transcript_fragment.startsWith('Scar is de broer'), uit.shots[0].transcript_fragment);
    toets('starttijd evenredig verschoven', uit.shots[0].start > 100 && uit.shots[0].start < 104, String(uit.shots[0].start));
    toets('ingreep gelogd', oordeel.ingrepen.some((i) => /instappunt verplaatst/.test(i)), JSON.stringify(oordeel));
    const geenUitweg = clip([shot(1, 100, 104, 'setup', 'En dan doet hij dat weer.'), shot(2, 110, 118, 'payoff', 'Hij doet de stem van Scar beter dan de film zelf.')]);
    toets('geen begrijpelijke zin over: harde fout', pasClipRegelsToe(geenUitweg, 'comedy').oordeel.fouten.some((f) => /opening zonder context/.test(f)));
    const cold = clip(
      [
        shot(1, 115, 118, 'hook', 'Hij doet de stem van Scar beter dan de film!'),
        shot(2, 100, 108, 'setup', 'Archi speelt Scar al twintig jaar op elk feest.'),
        shot(3, 110, 114, 'payoff', 'Long live the king, zegt hij dan.'),
      ],
      { hook: { type: 'h', tekst_overlay: 'Archi speelt Scar.', gesproken_start: '' } },
    );
    toets('comedy: cold open van de grap mag, als de context direct volgt', pasClipRegelsToe(cold, 'comedy').oordeel.fouten.length === 0, JSON.stringify(pasClipRegelsToe(cold, 'comedy').oordeel.fouten));
  }

  console.log('lengte per format');
  {
    // Mukbang 1: 48 s waarvan 15 s een Titanic-uitweiding.
    const c = clip(
      [
        shot(1, 100, 104, 'hook', 'Archi speelt Scar beter dan de film.'),
        shot(2, 104, 114, 'setup', 'Archi imiteert Scar uit de Lion King al jaren op elk feest, iedereen kent het.'),
        shot(3, 114, 129, 'escalatie', 'De Titanic vind ik eigenlijk een veel betere film, met die muziek en dat schip, weet je wel, eh ja.'),
        shot(4, 129, 138, 'escalatie', 'En dan begint Archi ineens met de stem van Scar tegen de ober.'),
        shot(5, 138, 148, 'payoff', 'Long live the king, zegt hij tegen de ober, en iedereen ligt dubbel.'),
      ],
      {
        verhaallijn: {
          belofte: 'Archi doet Scar beter dan de film',
          open_vraag: 'Hoe goed is zijn Scar-imitatie echt?',
          escalatie: ['hij doet het op elk feest', 'nu tegen de ober'],
          payoff: 'Long live the king tegen de ober en iedereen ligt dubbel',
          omslag: 'Je denkt dat het een feestgrap is, maar hij doet het tegen een vreemde',
        },
      },
    );
    toets('vooraf 48 s', Math.round(clipDuur(c)) === 48);
    const { clip: uit, oordeel } = pasClipRegelsToe(c, 'comedy');
    toets('ingekort tot binnen 35 s', clipDuur(uit) <= 35, `${clipDuur(uit)} s`);
    toets('de uitweiding (Titanic) is weg, de rest blijft', !uit.shots.some((s) => /Titanic/.test(s.transcript_fragment)) && uit.shots.some((s) => /ober/.test(s.transcript_fragment)), JSON.stringify(oordeel.ingrepen));
    toets('hook en payoff blijven', uit.shots[0].functie === 'hook' && uit.shots[uit.shots.length - 1].functie === 'payoff');
    toets('volgnummers opnieuw 1..n', uit.shots.every((s, i) => s.volgorde === i + 1));
    const teLang = clip([shot(1, 0, 20, 'hook', 'Platina is niet goud, zegt hij.'), shot(2, 20, 60, 'payoff', 'Platina is zeldzamer dan goud en toch goedkoper.')]);
    toets('niet in te korten zonder de boog te breken: harde fout', pasClipRegelsToe(teLang, 'comedy').oordeel.fouten.some((f) => /boven het maximum/.test(f)));
  }

  console.log('één verhaal, geen herhaling');
  {
    // Michelle 2: lelijk horloge + plastisch chirurg, en de vraag twee keer.
    const c = clip([
      shot(1, 1650, 1655, 'hook', 'Vijf miljoen voor dit horloge. Zou jij dit dragen?'),
      shot(2, 1655, 1662, 'escalatie', 'Zou jij dit dragen? Ja, ligt aan de gelegenheid.'),
      shot(3, 1900, 1910, 'payoff', 'Mijn plastisch chirurg zei dat ik nooit meer mocht lachen na de operatie.'),
    ]);
    toets('twee losse verhalen gesignaleerd', tweeVerhalen(c) !== null, String(tweeVerhalen(c)));
    toets('herhaalde vraag gesignaleerd', herhaaldeZinnen(c).length === 1 && herhaaldeZinnen(c)[0].shots.join(',') === '1,2', JSON.stringify(herhaaldeZinnen(c)));
    const callback = clip([shot(1, 100, 105, 'hook', 'Platina is niet goud en beleggers vergeten dat.'), shot(2, 1900, 1910, 'payoff', 'Twintig minuten later: platina is goedkoper dan goud, beleggers kopen alsnog goud.')]);
    toets('een callback met dezelfde woorden is geen tweede verhaal', tweeVerhalen(callback) === null);
  }

  console.log('comedy: het sterkste moment niet afgekapt');
  {
    const c = clip([shot(1, 100, 104, 'hook', 'Archi speelt Scar beter dan de film.'), shot(2, 104, 115, 'payoff', 'Long live the king, zegt hij tegen de ober.')]);
    const r = pasClipRegelsToe(c, 'comedy', {
      energie: [{ soort: 'volumepiek', start: 115.4, end: 116.6, sterkte: 0.9 }],
      transcript: [{ start_seconds: 115.2, end_seconds: 116.8, text: '(gelach) hahaha' }],
    });
    toets('slot verlengd tot na de lach', r.clip.shots[1].end >= 116.8 - 1e-9, String(r.clip.shots[1].end));
    toets('niet bij uitleg', pasClipRegelsToe(c, 'uitleg', { energie: [{ soort: 'volumepiek', start: 115.4, end: 116.6, sterkte: 0.9 }] }).clip.shots[1].end === 115);
  }

  console.log('plan: score en afvallen');
  {
    const goed = clip([shot(1, 10, 14, 'hook', 'Platina is niet goud.'), shot(2, 40, 52, 'payoff', 'Platina is zeldzamer dan goud en toch goedkoper.')], { titel_intern: 'goed', score: 8 });
    const slecht = clip([shot(1, 10, 14, 'setup', 'En dan doet hij dat.'), shot(2, 20, 30, 'escalatie', 'De prijs daalde.')], { titel_intern: 'slecht', score: 9 });
    const log: string[] = [];
    const r = pasPlanRegelsToe({ clips: [goed, slecht] }, 'uitleg', { log: (m) => log.push(m) });
    toets('clip met harde fouten valt af (score ≤ 5), ook met een hoge examenscore', r.plan.clips.length === 1 && r.plan.clips[0].titel_intern === 'goed', log.join(' | '));
    toets('reden gelogd', log.some((m) => /FOUT .* score ≤ 5/.test(m)));
    const alleen = pasPlanRegelsToe({ clips: [slecht] }, 'uitleg');
    toets('alles fout: de sterkste blijft (geen leeg plan)', alleen.plan.clips.length === 1);
    const prompt = regelsVoorPrompt(r.oordelen, 'uitleg');
    toets('promptblok met format en harde fouten', /format uitleg: 25–50 s/.test(prompt) && /HARD —/.test(prompt), prompt.slice(0, 200));
  }

  console.log('verhaaldokter: schrappen en het nazinnetje knippen');
  {
    const c = clip([
      shot(1, 10, 14, 'hook', 'Platina is niet goud.'),
      shot(2, 20, 30, 'escalatie', 'De Titanic is ook een mooie film.'),
      shot(3, 40, 52, 'payoff', 'Platina is zeldzamer dan goud en toch goedkoper. Dus het wordt minder voorspelbaar.'),
    ], { kaarten: [{ shot: 3, tekst: '€1.000' }] });
    const diff = verhaaldokterDiffSchema.parse({ clips: [{ clip: 1, verwijderen: false, score: 8, reden: 'x', schrap_shots: [2, 3], knip_slot: 'Dus het wordt minder voorspelbaar.' }] });
    const log: string[] = [];
    const uit = pasVerhaaldokterToe({ clips: [c] }, diff, (m) => log.push(m)).clips[0];
    toets('uitweiding geschrapt, laatste payoff nooit', uit.shots.length === 2 && uit.shots[1].functie === 'payoff', JSON.stringify(uit.shots.map((s) => s.functie)));
    toets('nazinnetje geknipt', uit.shots[1].transcript_fragment === 'Platina is zeldzamer dan goud en toch goedkoper.' && uit.shots[1].end < 52, JSON.stringify(uit.shots[1]));
    toets('kaart meegenummerd naar het nieuwe shot', uit.kaarten?.[0]?.shot === 2, JSON.stringify(uit.kaarten));
    toets('knipSlot weigert tekst die er niet aan het eind staat', knipSlot(c.shots[2], 'Platina is zeldzamer') === null);
  }

  console.log('comedy-tempo in de retentie-editor');
  {
    const woorden: BronWoord[] = [];
    let t = 100;
    for (let i = 0; i < 40; i++) {
      woorden.push({ w: `woord${i}`, s: Math.round(t * 1000) / 1000, e: Math.round((t + 0.3) * 1000) / 1000 });
      t += 0.4 + (i === 10 ? 0.37 : 0);
    }
    const seg = (): Shot[] => [{ volgorde: 1, start: 99.9, end: woorden[39].e + 0.1, functie: 'setup', focusX: 0.5, focusW: 0.12 }];
    const pauzes = (f?: 'comedy' | 'interview') => pasRetentieToe(seg(), { bronWoorden: woorden, doelen: { ...STANDAARD_DOELEN }, ondertitels: true, formaat: f }).ingrepen.filter((g) => g.soort === 'pauze').length;
    toets('pauze van 0,47 s: bij interview blijft hij', pauzes('interview') === 0);
    toets('…bij comedy gaat hij eruit', pauzes('comedy') === 1);
  }

  console.log('prompts');
  {
    const f = { naam: 'comedy', min: 15, max: 35 };
    toets('promptversie gebumpt naar plan-7.x', /^plan-7\./.test(PROMPT_VERSION_PLAN), PROMPT_VERSION_PLAN);
    for (const [naam, p] of [['schets', schetsSystem(9, f)], ['examen', planExamenSystem(9, f)], ['verhaaldokter', verhaaldokterSystem(f)]] as const) {
      toets(`${naam}: clipregels met lengte en afsluiters`, /CLIPREGELS/.test(p) && /15–35 seconden/.test(p) && /ik ben benieuwd wat jij hiervan vindt/.test(p));
    }
    toets('verhaaldokter: per shot de schrapvraag en knip_slot', /zou de clip zonder dit shot slechter zijn/.test(verhaaldokterSystem(f)) && /knip_slot/.test(verhaaldokterSystem(f)));
  }

  console.log('één doorlopende lijn: sprongen, verwijzingen en onthullingen');
  {
    // PLATINA clip 2, echte bronzinnen (captiontijden lopen door: "En dat is
    // Platina." van 12,3 tot 20,4 s).
    const transcript = [
      { start_seconds: 0, end_seconds: 5.82, text: 'Goud staat in het nieuws, zilver ook, maar er is een derde edelmetaal dat zeldzamer is dan' },
      { start_seconds: 5.82, end_seconds: 6.82, text: 'beide.' },
      { start_seconds: 6.82, end_seconds: 11.32, text: 'En voor het grootste deel van de moderne geschiedenis duurder was dan goud en toch nauwelijks' },
      { start_seconds: 11.32, end_seconds: 12.32, text: 'ter sprake komt.' },
      { start_seconds: 12.32, end_seconds: 20.35, text: 'En dat is Platina.' },
      { start_seconds: 130, end_seconds: 133, text: 'Ten tweede is het aanbod extreem geconcentreerd.' },
      { start_seconds: 133, end_seconds: 138, text: 'Meer dan 70 procent van alle platina ter wereld komt uit Zuid-Afrika.' },
      { start_seconds: 164, end_seconds: 172, text: 'De Platina-markt heeft in 2026 voor het vierde jaar op rij een tekort van circa 297.000 troy ounce.' },
      { start_seconds: 324, end_seconds: 330, text: 'Platina wordt misschien nog minder besproken dan goud of zilver. Maar dat is misschien ook precies wat het interessant maakt.' },
    ];
    const collage = clip([
      shot(1, 0, 7, 'hook', 'Goud staat in het nieuws, zilver ook, maar er is een derde edelmetaal dat zeldzamer is dan beide.'),
      shot(2, 7, 12, 'setup', 'En voor het grootste deel van de moderne geschiedenis duurder was dan goud en toch nauwelijks ter sprake komt.'),
      shot(3, 133, 138, 'escalatie', 'Meer dan 70 procent van alle platina ter wereld komt uit Zuid-Afrika.'),
      shot(4, 165, 172, 'escalatie', 'De Platina-markt heeft in 2026 voor het vierde jaar op rij een tekort van circa 297.000 troy ounce.'),
      shot(5, 324, 330, 'payoff', 'Platina wordt misschien nog minder besproken dan goud of zilver. Maar dat is misschien ook precies wat het interessant maakt.'),
    ]);
    const r = pasClipRegelsToe(collage, 'uitleg', { transcript });
    toets('drie sprongen in een uitlegclip: afgewezen als collage', r.oordeel.fouten.some((f) => /sprongen door de bron/.test(f)), JSON.stringify(r.oordeel.fouten));
    const s2 = r.clip.shots.find((x) => x.volgorde === 2)!;
    toets('de overgeslagen onthulling "En dat is Platina." komt erbij', /En dat is Platina\.$/.test(s2.transcript_fragment ?? '') && s2.end > 13 && s2.end < 16, JSON.stringify(s2));
    toets('sprongen geteld vanaf 15 s; aanscherpen telt niet', sprongen({ shots: [shot(1, 0, 5, 'hook', 'a.'), shot(2, 9, 14, 'payoff', 'b.')] }).length === 0);
    toets('maximum per format: comedy 1, interview 2, uitleg 2', maxSprongen('comedy') === 1 && maxSprongen('interview') === 2 && maxSprongen('uitleg') === 2);

    // Na een echte sprong een zin die terugwijst: de zin ervoor komt mee.
    const bron = [
      { start_seconds: 10, end_seconds: 14, text: 'Het tekort loopt al vier jaar op.' },
      { start_seconds: 95, end_seconds: 98, text: 'Goud beweegt op vertrouwen en monetaire politiek.' },
      { start_seconds: 98, end_seconds: 103, text: 'En platina beweegt ook daarop, maar ook op autoverkopen.' },
    ];
    const terug = clip([
      shot(1, 10, 14, 'hook', 'Het tekort loopt al vier jaar op.'),
      shot(2, 98, 103, 'payoff', 'En platina beweegt ook daarop, maar ook op autoverkopen.'),
    ]);
    const rt = pasClipRegelsToe(terug, 'uitleg', { transcript: bron });
    const t2 = rt.clip.shots[1];
    toets('"daarop" na een sprong: de zin waar het naar verwijst komt erbij', t2.start === 95 && /^Goud beweegt op vertrouwen/.test(t2.transcript_fragment ?? ''), JSON.stringify(t2));
    toets('wijstTerug herkent "daarop" en laat een gewone zin staan', wijstTerug('En platina beweegt ook daarop') && !wijstTerug('Meer dan 70 procent komt uit Zuid-Afrika.'));
    toets('prompt noemt de collage- en sprongregel', /GEEN COLLAGE/.test(planExamenSystem(4, { naam: 'uitleg', min: 25, max: 50 })) && /GEEN GAT BIJ EEN SPRONG/.test(planExamenSystem(4, { naam: 'uitleg', min: 25, max: 50 })));
    toets('schets stuurt niet meer op fragmenten die ver uit elkaar liggen', !/fragmenten die ver uit elkaar liggen/.test(schetsSystem(4, { naam: 'uitleg', min: 25, max: 50 })));
  }

  console.log('snelle route: selectie, parallel, cross-clip');
  {
    toets('standaardroute is de oude (enkel) tot de A/B hem goedkeurt', planRoute() === 'enkel');
    process.env.PLAN_ROUTE = 'parallel';
    toets('PLAN_ROUTE=parallel zet de snelle route aan', planRoute() === 'parallel');
    delete process.env.PLAN_ROUTE;
    // Parallel met plafond: nooit meer dan 2 tegelijk, volgorde behouden, een fout breekt de rest niet.
    let bezig = 0;
    let piek = 0;
    const taken = [30, 10, 20, 5, 15].map((ms, i) => async () => {
      bezig++;
      piek = Math.max(piek, bezig);
      await new Promise((r) => setTimeout(r, ms));
      bezig--;
      if (i === 2) throw new Error('kapot');
      return i;
    });
    const r = await metPlafond(taken, 2);
    toets('hoogstens 2 tegelijk', piek === 2, String(piek));
    toets('resultaten in volgorde, fout per taak', r.map((x) => (x.status === 'fulfilled' ? x.value : 'x')).join(',') === '0,1,x,3,4');
    // Cross-clip: twee clips op hetzelfde moment → de zwakste valt.
    const a = clip([shot(1, 100, 110, 'hook', 'Platina is niet goud.'), shot(2, 110, 130, 'payoff', 'Platina is zeldzamer.')], { titel_intern: 'A', score: 8 });
    const b = clip([shot(1, 105, 125, 'hook', 'Platina is zeldzaam.'), shot(2, 125, 132, 'payoff', 'En goedkoper.')], { titel_intern: 'B', score: 7 });
    const c = clip([shot(1, 500, 510, 'hook', 'Waterstof.'), shot(2, 510, 530, 'payoff', 'Twee procent op schema.')], { titel_intern: 'C', score: 6.5, hook: { type: 'h', tekst_overlay: 'Platina is niet goud.', gesproken_start: '' } });
    const x = crossClipCheck({ clips: [a, b, c] });
    toets('dubbel moment: de zwakste valt', x.plan.clips.map((k) => k.titel_intern).join(',') === 'A,C', JSON.stringify(x.log));
    toets('dubbele hooktekst gesignaleerd', x.signalen.some((m) => /dezelfde hooktekst/.test(m)));
    // Selectie-schema en prompts.
    const sel = selectieSchema.parse({ kandidaten: [{ kandidaat: 3, score: 8, structure_type: 's', hook_type: 'h', scroll_stop: { oordeel: 'stopt', waarom: 'x' }, opdracht: 'einde op de onthulling' }] });
    toets('selectie-schema: kleine output per overlever', sel.kandidaten[0].kandidaat === 3);
    const sys = selectieSystem(9, { naam: 'comedy', min: 15, max: 35 });
    toets('selectieprompt: alleen stap 1 + cross-clip-keuzes', /STAP 1/.test(sys) && !/STAP 2 — UITWERKEN/.test(sys) && /geen twee overlevers/.test(sys) && /CLIPREGELS/.test(sys));
    const opd = uitschrijfOpdracht(sel.kandidaten[0], '- kandidaat 5 "x": brontijden 1-2');
    toets('uitschrijfopdracht: precies één clip, andere momenten genoemd', /precies één clip/.test(opd) && /kandidaat 5/.test(opd));
    // Overtredingen tellen voor de A/B.
    const fout = clip([shot(1, 0, 10, 'setup', 'En dan doet hij dat.'), shot(2, 10, 60, 'payoff', 'Platina is zeldzamer. Ik ben benieuwd wat jij hiervan vindt.')]);
    const ov = regelOvertredingen(fout, 'comedy');
    toets('overtredingen: lengte, einde en opening', ov.length === 3 && /lengte/.test(ov[0]) && ov.some((o) => /afsluiter/.test(o)) && ov.some((o) => /opening/.test(o)), JSON.stringify(ov));
  }

  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
