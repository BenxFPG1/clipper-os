/**
 * Tests voor de signalenlaag van de planner (src/lib/planner/signalen.ts):
 * instappunt-kwaliteit, lach- en reactiemarkers, vraag→antwoord, dode
 * woorden, het meetpakket per kandidaat en de scroll-stop-begrenzing. Puur
 * rekenwerk, zonder netwerk en zonder model (het beeldoordeel slaat zichzelf
 * over zonder lokale bron).
 *
 * Draaien: npm run test:signalen
 */
import {
  beoordeelHookBeelden,
  dodeWoorden,
  instappuntKwaliteit,
  lachmarkers,
  lokaleBron,
  meetSignalen,
  signalenVoorPrompt,
  vraagAntwoordParen,
  watWerktBijAnderen,
  woordenInVenster,
} from '../src/lib/planner/signalen';
import { pasScrollStopToe } from '../src/lib/planner';
import type { ClipPlan, Energiemoment } from '../src/lib/planner/schema';
import type { TranscriptSegment } from '../src/lib/ingest/transcript';
import type { VaultSnapshot } from '../src/lib/vault';

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
  console.log('instappunt-kwaliteit');
  {
    const dus = instappuntKwaliteit('Dus toen zei hij dat het niet kon.');
    toets('"dus toen zei hij…" is zwak', dus.oordeel === 'zwak', JSON.stringify(dus));
    toets('en noemt het verbindingswoord', dus.redenen.some((r) => r.includes('dus')), dus.redenen.join(', '));
    const sterk = instappuntKwaliteit('Ik verloor in één nacht twee miljoen euro.');
    toets('volledige zin met getal is sterk', sterk.oordeel === 'sterk', JSON.stringify(sterk));
    const hij = instappuntKwaliteit('Hij had het geld al lang uitgegeven voordat');
    toets('"hij" zonder antecedent wordt afgestraft', hij.redenen.some((r) => r.includes('hij')) && hij.score < 0.7, JSON.stringify(hij));
    const naam = instappuntKwaliteit('Toen Mark belde, zei hij dat alles weg was.');
    toets('"hij" ná een eigennaam telt niet als los', !naam.redenen.some((r) => r.includes('"hij"')), JSON.stringify(naam));
    const vraag = instappuntKwaliteit('Wat zou jij doen met een miljoen?');
    toets('opening met een vraag is sterk', vraag.oordeel === 'sterk' && vraag.redenen.includes('opent met een vraag'), JSON.stringify(vraag));
    const eh = instappuntKwaliteit('eh ja nou kijk het is eigenlijk zo dat');
    toets('opvulling vooraan is zwak', eh.oordeel === 'zwak', JSON.stringify(eh));
    const bijzin = instappuntKwaliteit('Het geld dat we hadden was in één week weg.');
    toets('"dat" als bijzin-inleider is geen losse verwijzing', !bijzin.redenen.some((r) => r.includes('"dat"')), JSON.stringify(bijzin));
    const dat = instappuntKwaliteit('Dat was het moment dat alles misging.');
    toets('"Dat" vooraan is wel een verwijzing', dat.redenen.some((r) => r.includes('"dat"')), JSON.stringify(dat));
    toets('lege instap is zwak', instappuntKwaliteit('').oordeel === 'zwak');
  }

  console.log('lach- en reactiemarkers');
  {
    const m = lachmarkers('(lacht) nee echt, hahaha dat meen je niet');
    toets('(lacht) herkend', m.includes('(lacht)'), m.join(','));
    toets('hahaha herkend', m.includes('haha'), m.join(','));
    toets('[Laughter] herkend als lach', lachmarkers('and then [Laughter] he left').includes('(lacht)'));
    toets('interjectie "wauw" herkend', lachmarkers('wauw, dat had ik niet verwacht').includes('interjectie'));
    toets('gewone tekst zonder markers', lachmarkers('We hebben het geld netjes teruggestort.').length === 0);
    toets('"hah" in een woord is geen lach', lachmarkers('de schaal van de Haha-berg').length <= 1);
  }

  console.log('vraag → antwoord');
  {
    const segs: TranscriptSegment[] = [
      { start_seconds: 10, end_seconds: 12, text: 'Hoeveel heb je toen verloren?' },
      { start_seconds: 12.5, end_seconds: 15, text: 'Ruim twee miljoen, in één nacht.' },
      { start_seconds: 20, end_seconds: 21, text: 'Echt waar?' },
      { start_seconds: 21.2, end_seconds: 22, text: 'Meen je dat?' },
      { start_seconds: 30, end_seconds: 31, text: 'En toen?' },
      { start_seconds: 40, end_seconds: 42, text: 'Toen ben ik opnieuw begonnen.' },
    ];
    toets('één echt paar gevonden', vraagAntwoordParen(segs) === 1, String(vraagAntwoordParen(segs)));
  }

  console.log('dode woorden');
  {
    const d = dodeWoorden('eh ik ik bedoel zeg maar het is gewoon zo');
    toets('opvulling en herhaling geteld', d.dodeWoorden >= 4, JSON.stringify(d));
    toets('schone zin heeft geen dode woorden', dodeWoorden('Het geld was in één nacht weg.').dodeWoorden === 0);
  }

  console.log('woorden in een venster');
  {
    const segs: TranscriptSegment[] = [{ start_seconds: 0, end_seconds: 4, text: 'een twee drie vier vijf zes zeven acht' }];
    const w = woordenInVenster(0, 2, segs);
    toets('benadering zonder woordtijden verdeelt gelijkmatig', w.length === 4 && w[0].w === 'een', w.map((x) => x.w).join(' '));
    const exact = woordenInVenster(1, 2, segs, [{ w: 'a', s: 0.5, e: 0.9 }, { w: 'b', s: 1.1, e: 1.4 }, { w: 'c', s: 1.9, e: 2.3 }]);
    toets('met woordtijden exact op het midden', exact.map((x) => x.w).join('') === 'b', exact.map((x) => x.w).join(''));
  }

  console.log('meetpakket per kandidaat');
  {
    const transcript: TranscriptSegment[] = [
      { start_seconds: 100, end_seconds: 103, text: 'Ik verloor in één nacht twee miljoen euro.' },
      { start_seconds: 103, end_seconds: 107, text: 'Hoe kan dat nou?' },
      { start_seconds: 107.5, end_seconds: 112, text: 'Ik had alles op één aandeel gezet, zeg maar.' },
      { start_seconds: 114, end_seconds: 118, text: 'En toen belde de bank. (lacht)' },
      { start_seconds: 200, end_seconds: 203, text: 'Dus toen zei hij dat het goed kwam.' },
      { start_seconds: 203, end_seconds: 207, text: 'En eh ja dat was het eigenlijk wel.' },
    ];
    const energie: Energiemoment[] = [
      { soort: 'stilte', start: 112, end: 114, sterkte: 0.4 },
      { soort: 'volumepiek', start: 118.3, end: 119, sterkte: 0.7 },
    ];
    const clips = [
      {
        titel_intern: 'twee miljoen',
        shots: [
          { volgorde: 1, start: 100, end: 107, functie: 'hook' },
          { volgorde: 2, start: 107.5, end: 112, functie: 'escalatie' },
          { volgorde: 3, start: 114, end: 119, functie: 'payoff' },
        ],
      },
      { titel_intern: 'zwakke opening', shots: [{ volgorde: 1, start: 200, end: 207, functie: 'hook' }] },
    ];
    const s = meetSignalen(clips, transcript, energie);
    toets('één pakket per kandidaat', s.length === 2);
    toets('sterke instap herkend', s[0].instap.oordeel === 'sterk', JSON.stringify(s[0].instap));
    toets('zwakke instap herkend', s[1].instap.oordeel === 'zwak', JSON.stringify(s[1].instap));
    toets('stilte vóór de onthulling gemeten', s[0].stilteVoorOnthulling !== null && s[0].stilteVoorOnthulling >= 1.9, String(s[0].stilteVoorOnthulling));
    toets('lach in de tekst gevonden', s[0].reacties.markers.includes('(lacht)'), JSON.stringify(s[0].reacties));
    toets('volumepiek vlak na een zinseinde telt als reactie', s[0].reacties.pieken === 1, JSON.stringify(s[0].reacties));
    toets('vraag→antwoord in de shots', s[0].vraagAntwoord === 1, String(s[0].vraagAntwoord));
    toets('dode woorden in de zwakke kandidaat', s[1].aanloop.dodeWoorden >= 2, JSON.stringify(s[1].aanloop));
    const tekst = signalenVoorPrompt(s);
    toets('prompt: één compacte regel per kandidaat', tekst.split('\n').length === 2 && tekst.split('\n').every((r) => r.length < 500), tekst);
    toets('prompt noemt instap, stilte en reactie', /instap sterk/.test(tekst) && /stilte vóór onthulling/.test(tekst) && /reactie:/.test(tekst), tekst);
  }

  console.log('scroll-stop telt mee in de score');
  {
    const clip = (score: number, oordeel?: 'stopt' | 'twijfel' | 'scrollt_door') =>
      ({ titel_intern: 'x', score, ...(oordeel ? { scroll_stop: { oordeel, waarom: 'test' } } : {}) }) as unknown as ClipPlan['clips'][number];
    const plan: ClipPlan = { clips: [clip(9, 'stopt'), clip(9, 'twijfel'), clip(8, 'scrollt_door'), clip(8)] };
    const n = pasScrollStopToe(plan);
    toets('twee clips begrensd', n === 2, String(n));
    toets('stopt blijft 9', plan.clips[0].score === 9);
    toets('twijfel hoogstens 7', plan.clips[1].score === 7);
    toets('scrollt door hoogstens 5', plan.clips[2].score === 5);
    toets('zonder oordeel ongemoeid (oudere plannen)', plan.clips[3].score === 8);
  }

  console.log('grenzen en terugval');
  {
    toets('geen lokale bron → null', lokaleBron('bestaat-niet-00000000', 'https://youtube.com/watch?v=x') === null);
    const leeg = await beoordeelHookBeelden([{ kandidaat: 1, hookStart: 10 }], null);
    toets('zonder bron geen beeldoordeel en geen call', leeg.size === 0);
    const vault = { trends: { periodeDagen: 14, datum: 'x', hooks: [{ slug: 'vonnis', accounts: 3, posts: 5 }], structuren: [] } } as unknown as VaultSnapshot;
    const anderen = watWerktBijAnderen(vault, 'Eerste knip binnen 1,2 s.');
    toets('wat werkt bij anderen: normen plus trend', anderen.includes('1,2 s') && anderen.includes('vonnis'), anderen);
    toets('zonder normen en trends leeg', watWerktBijAnderen({} as VaultSnapshot, '') === '');
    toets('lege clips geven geen fout', meetSignalen([], [], []).length === 0);
  }

  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
