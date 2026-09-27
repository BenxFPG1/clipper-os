/**
 * Tests voor de mechanische kant van de verhaaldokter: de metingen waarop de
 * LLM-pas moet doorvragen (parafrase tussen omslag en payoff, vage
 * stakes-taal, cross-clip omslagherhaling). Puur code, geen model — net als
 * de poort en de scriptpoort.
 *
 * Draaien: npm run test:verhaaldokter
 */
import {
  keurMerkveiligheid,
  keurUitvoerbaarheid,
  keurVerhaaldokter,
  pasMerkveiligheidToe,
  rapportVoorPrompt,
} from '../src/lib/planner/verhaaldokterpoort';
import { campagneRegel, pasVerhaaldokterToe } from '../src/lib/planner';
import { characterMapSchema, examenClipSchema, clipSchema } from '../src/lib/planner/schema';
import { planKaartenOpTijdlijn } from '../src/lib/roughcut/tekstkaarten';
import { selecteerMomenten } from '../src/lib/planner/energie';
import type { Clip, ClipPlan, Energiemoment } from '../src/lib/planner/schema';

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

function basisClip(overrides: Partial<Clip> = {}, titel = 'test-clip'): Clip {
  return {
    titel_intern: titel,
    structure_type: 'belofte_afstraffing',
    prioriteit: 1,
    score: 8,
    verhaallijn: {
      belofte: 'Hij zegt dat goud waardeloos is.',
      open_vraag: 'Klopt dat echt?',
      escalatie: ['Eerst lacht de tafel mee, maar dan komt er een cijfer op tafel.', 'Dus wordt de toon serieuzer.'],
      payoff: 'Centrale banken kopen al drie jaar recordhoeveelheden goud.',
      omslag: 'Vlak voor de payoff denkt de kijker dat de spreker gelijk krijgt; in plaats daarvan blijkt het tegendeel.',
    },
    hook: { type: 'vonnis_zonder_context', tekst_overlay: 'x', gesproken_start: 'x' },
    hooks: [
      { type: 'vonnis_zonder_context', tekst_overlay: 'x', gesproken_start: 'x', waarom: 'x' },
      { type: 'getal_absurditeit', tekst_overlay: 'y', gesproken_start: 'y', waarom: 'y' },
      { type: 'onthoud_deze_zin', tekst_overlay: 'z', gesproken_start: 'z', waarom: 'z' },
    ],
    context_kaart: null,
    shots: [
      // Echte gesproken tekst: de uitvoerbaarheidscheck toetst of belofte en
      // payoff te horen zijn, en met placeholders is niets te horen.
      { volgorde: 1, start: 0, end: 3, functie: 'hook', transcript_fragment: 'Hij zegt dat goud waardeloos is. Klopt dat echt?', edit_notitie: '' },
      { volgorde: 2, start: 3, end: 10, functie: 'payoff', transcript_fragment: 'Centrale banken kopen al drie jaar recordhoeveelheden goud.', edit_notitie: '' },
    ],
    caption: { tiktok: 'Wat denk jij?', reels: 'Wat denk jij?', shorts: 'Wat denk jij?' },
    verplichte_elementen: [],
    varianten: [
      { aanpak: 'reverse_hook', hook_tekst: 'x', wijziging: 'y' },
      { aanpak: 'kort_skelet', hook_tekst: 'x', wijziging: 'y' },
    ],
    risico: 'geen',
    waarom_dit_werkt: 'test',
    ...overrides,
  } as Clip;
}

function planVan(...clips: Clip[]): ClipPlan {
  return { clips };
}

console.log('schone verhaallijn geeft geen signalen');
{
  const rapport = keurVerhaaldokter(planVan(basisClip()));
  toets('geen signalen', rapport.signalen.length === 0, JSON.stringify(rapport.signalen));
}

console.log('omslag die de payoff parafraseert');
{
  const clip = basisClip({
    verhaallijn: {
      belofte: 'Hij zegt dat goud waardeloos is.',
      open_vraag: 'Klopt dat echt?',
      escalatie: ['Eerst lacht de tafel mee, maar dan komt er een cijfer op tafel.', 'Dus wordt de toon serieuzer.'],
      payoff: 'Centrale banken kopen al drie jaar recordhoeveelheden goud.',
      // Vrijwel woord-voor-woord dezelfde zin als de payoff — geen "wat dacht
      // de kijker vlak ervoor", puur een parafrase van de uitkomst.
      omslag: 'Centrale banken kopen al drie jaar lang recordhoeveelheden goud, blijkt uit de cijfers.',
    },
  });
  const rapport = keurVerhaaldokter(planVan(clip));
  toets(
    'parafrase-signaal',
    rapport.signalen.some((s) => s.signaal.includes('overlapt sterk met "payoff"')),
    JSON.stringify(rapport.signalen),
  );
}

console.log('vage stakes-taal');
{
  const clip = basisClip({
    verhaallijn: {
      belofte: 'Dit is best wel belangrijk om te weten.',
      open_vraag: 'Waarom is dat interessant?',
      escalatie: ['Eerst lijkt het niks, maar dan blijkt het meer.', 'Dus gaat het verder.'],
      payoff: 'Uiteindelijk komt er een concreet bedrag op tafel: 12.000 euro.',
      omslag: 'De kijker dacht dat het om een paar euro ging; het blijkt duizenden euro’s te schelen.',
    },
  });
  const rapport = keurVerhaaldokter(planVan(clip));
  toets(
    'vage-stakes-signaal',
    rapport.signalen.some((s) => s.signaal.includes('vage stakes-taal')),
    JSON.stringify(rapport.signalen),
  );
}

console.log('twee clips met (bijna) dezelfde omslag');
{
  const omslagTekst =
    'Vlak voor de payoff denkt de kijker dat de expert gelijk krijgt met zijn voorspelling; in plaats daarvan blijkt precies het tegenovergestelde waar.';
  const a = basisClip(
    {
      verhaallijn: {
        belofte: 'x',
        open_vraag: 'y',
        escalatie: ['Eerst dit, maar dan dat.', 'Dus gebeurt er meer.'],
        payoff: 'De voorspelling van de expert klopte niet.',
        omslag: omslagTekst,
      },
    },
    'clip A',
  );
  const b = basisClip(
    {
      verhaallijn: {
        belofte: 'x',
        open_vraag: 'y',
        escalatie: ['Eerst dit, maar dan dat.', 'Dus gebeurt er meer.'],
        payoff: 'Een heel andere uitkomst dan verwacht.',
        omslag: omslagTekst,
      },
    },
    'clip B',
  );
  const rapport = keurVerhaaldokter(planVan(a, b));
  toets(
    'cross-clip-herhalingssignaal',
    rapport.signalen.some((s) => s.signaal.includes('lijkt sterk op clip')),
    JSON.stringify(rapport.signalen),
  );
}

console.log('rapportVoorPrompt');
{
  const leeg = rapportVoorPrompt({ signalen: [] });
  toets('leeg rapport geeft leeg blok', leeg === '');

  const gevuld = rapportVoorPrompt({ signalen: [{ clipIndex: 0, titel: 'x', signaal: 'test-signaal' }] });
  toets('gevuld rapport bevat het signaal', gevuld.includes('test-signaal') && gevuld.includes('MECHANISCHE SIGNALEN'));
}

console.log('pasVerhaaldokterToe — alleen verhaallijn, score en selectie veranderen');
{
  const plan = planVan(basisClip({}, 'een'), basisClip({}, 'twee'), basisClip({}, 'drie'));
  const nieuweLijn = { ...plan.clips[0].verhaallijn, payoff: 'Een heel andere payoff met een concreet detail.' };
  const uit = pasVerhaaldokterToe(plan, {
    clips: [
      { clip: 1, verwijderen: false, score: 9, verhaallijn: nieuweLijn, reden: 'sterker' },
      { clip: 2, verwijderen: true, score: 4, reden: 'weetje' },
      // clip 3 niet genoemd: blijft zoals hij was
    ],
  });
  toets('verwijderde clip is weg', uit.clips.length === 2 && !uit.clips.some((c) => c.titel_intern === 'twee'));
  toets('verhaallijn en score overgenomen', uit.clips[0].verhaallijn.payoff === nieuweLijn.payoff && uit.clips[0].score === 9);
  toets('hooks en shots blijven byte voor byte staan',
    JSON.stringify(uit.clips[0].hooks) === JSON.stringify(plan.clips[0].hooks) &&
      JSON.stringify(uit.clips[0].shots) === JSON.stringify(plan.clips[0].shots));
  toets('niet-genoemde clip blijft ongewijzigd', JSON.stringify(uit.clips[1]) === JSON.stringify(plan.clips[2]));

  const alles = pasVerhaaldokterToe(plan, { clips: plan.clips.map((_, i) => ({ clip: i + 1, verwijderen: true, score: 3, reden: 'x' })) });
  toets('alles verwijderen wordt genegeerd', alles.clips.length === 3);
}

console.log('energie — quotum per soort');
{
  const momenten: Energiemoment[] = [
    ...Array.from({ length: 30 }, (_, i) => ({ soort: 'volumepiek' as const, start: i * 10, end: i * 10 + 1, sterkte: 0.9 })),
    ...Array.from({ length: 10 }, (_, i) => ({ soort: 'stilte' as const, start: 500 + i * 10, end: 500 + i * 10 + 2, sterkte: 0.4 })),
    ...Array.from({ length: 4 }, (_, i) => ({ soort: 'tempowisseling' as const, start: 900 + i * 10, end: 900 + i * 10 + 5, sterkte: 0.6 })),
  ];
  const uit = selecteerMomenten(momenten);
  const tel = (soort: string) => uit.filter((m) => m.soort === soort).length;
  toets('stiltes worden niet verdrongen door pieken', tel('stilte') === 10, `stiltes=${tel('stilte')}`);
  toets('pieken vullen de restruimte op, tot het plafond', uit.length === 40 && tel('volumepiek') === 26, `totaal=${uit.length} pieken=${tel('volumepiek')}`);
  toets('uitvoer staat op tijdvolgorde', uit.every((m, i) => i === 0 || m.start >= uit[i - 1].start));
}

console.log('uitvoerbaarheid — de boog moet te horen zijn, niet in edit_notitie staan');
{
  // Naar clip 3 van de GoldRepublic-video: op papier "met haar eigen cijfers
  // is het −39%", maar dat cijfer zit alleen in een rekenkaart in
  // edit_notitie, en de payoff is een zin van twee seconden die de fout
  // herhaalt in plaats van hem aan te wijzen.
  const clip3 = basisClip({
    verhaallijn: {
      belofte: 'Negentig procent onder de piek: dat getal kan niet kloppen.',
      open_vraag: 'Hoe ver staat goud echt onder zijn record?',
      escalatie: ['De prijs is 1775, het record 2920.', 'Maar dan zegt ze zo’n 90% onder die piek.'],
      payoff: 'Met haar eigen cijfers is het −39%, niet 90%.',
      omslag: 'De kijker denkt dat 90% klopt; haar eigen getallen zeggen −39%.',
    },
    shots: [
      { volgorde: 1, start: 100, end: 104, functie: 'hook', transcript_fragment: 'De prijs staat nu rond de 1775 tot 1790 dollar.', edit_notitie: '' },
      { volgorde: 2, start: 120, end: 125, functie: 'escalatie', transcript_fragment: 'Het record van januari lag op 2920.', edit_notitie: 'rekenkaart: "1775/2920 = -39%"' },
      { volgorde: 3, start: 140, end: 142, functie: 'payoff', transcript_fragment: 'Zo’n 90% onder die piek.', edit_notitie: '' },
    ],
  });
  const s = keurUitvoerbaarheid(clip3);
  toets('payoff korter dan 3 s gemeld', s.some((x) => /payoff-shot\(s\) duren samen 2\.0 s/.test(x)), JSON.stringify(s));
  toets('cijfer 39 alleen in het plan gemeld', s.some((x) => /cijfer\(s\) 39/.test(x)), JSON.stringify(s));
  toets('kaart in edit_notitie die niet getekend wordt gemeld', s.some((x) => /edit_notitie van shot 2 vraagt een kaart/.test(x)), JSON.stringify(s));

  // Herstel: de kaart als plankaart en een payoff-shot waarin het te horen is.
  const hersteld = basisClip({
    ...clip3,
    kaarten: [{ shot: 2, tekst: '1775 / 2920 = -39%' }],
    shots: [
      clip3.shots[0],
      { ...clip3.shots[1], edit_notitie: '' },
      { volgorde: 3, start: 140, end: 145, functie: 'payoff', transcript_fragment: 'Dus met haar eigen cijfers staat goud zo’n 39 procent onder die piek, niet 90.', edit_notitie: '' },
    ],
  });
  const h = keurUitvoerbaarheid(hersteld);
  toets('hersteld: geen signalen meer', h.length === 0, JSON.stringify(h));
  toets('signalen komen in het rapport voor de verhaaldokter', keurVerhaaldokter(planVan(clip3)).signalen.length >= 3);
}

console.log('merkveiligheid');
{
  const betrapt = basisClip({ titel_intern: 'Het getal dat niet kan kloppen' });
  toets('zonder campagne geen signaal', keurMerkveiligheid(betrapt, null).length === 0);
  toets('met campagne: "kan niet kloppen" gemeld', keurMerkveiligheid(betrapt, 'GoldRepublic').length === 1, JSON.stringify(keurMerkveiligheid(betrapt, 'GoldRepublic')));
  toets('neutrale clip met campagne: geen signaal', keurMerkveiligheid(basisClip(), 'GoldRepublic').length === 0);
  const plan = planVan(basisClip({ titel_intern: 'a' }), basisClip({ titel_intern: 'b', risico: 'merkonveilig' }));
  const veilig = pasMerkveiligheidToe(plan);
  toets('risico "merkonveilig" wordt geschrapt', veilig.plan.clips.length === 1 && veilig.geschrapt[0] === 'b');
  toets('campagneregel leeg zonder campagne', campagneRegel(null) === '');
  toets('campagneregel noemt de klant en de harde regel', /GoldRepublic/.test(campagneRegel('GoldRepublic')) && /merkonveilig/.test(campagneRegel('GoldRepublic')));
}

console.log('schema — oude plannen blijven werken, nieuwe velden verplicht waar het moet');
{
  const oud = { ...basisClip(), verwachte_sterkte: 'hoog' as const };
  toets('oud plan zonder kaarten/scroll_stop parseert', clipSchema.safeParse(oud).success, JSON.stringify(clipSchema.safeParse(oud).error?.issues?.[0]));
  const examenZonderKaarten = examenClipSchema.safeParse({ ...oud, scroll_stop: { oordeel: 'stopt', waarom: 'x' } });
  toets('examen eist het veld kaarten (mag leeg)', !examenZonderKaarten.success);
  toets('examen met lege kaarten parseert', examenClipSchema.safeParse({ ...oud, scroll_stop: { oordeel: 'stopt', waarom: 'x' }, kaarten: [] }).success);
  const persoon = { naam: 'Sanne', rol: 'presentatrice', boog: 'x', sleutelmomenten: [{ start: 0, end: 1, wat: 'x', functie: 'setup' }], ironie: 'x' };
  toets('character map eist een voornaamwoord', !characterMapSchema.safeParse({ personen: [persoon], vondsten: [], spanningslijnen: [], reveals: [] }).success);
  toets('character map met voornaamwoord parseert', characterMapSchema.safeParse({ personen: [{ ...persoon, voornaamwoord: 'zij' }], vondsten: [], spanningslijnen: [], reveals: [] }).success);
}

console.log('plankaarten op de tijdlijn');
{
  const segmenten = [
    { volgorde: 1, start: 10, end: 13 },
    { volgorde: 2, start: 20, end: 22 },
    { volgorde: 2.01, start: 22.5, end: 25 }, // retentiedeel van shot 2
    { volgorde: 3, start: 30, end: 34 },
  ];
  const k = planKaartenOpTijdlijn(segmenten, [{ shot: 2, tekst: '1775 / 2920 = -39%' }, { shot: 3, tekst: 'x' }, { shot: 9, tekst: 'bestaat niet' }], 2.4);
  toets('kaart op het begin van zijn shot (+0,2 s)', Math.abs(k[0].start - 3.2) < 1e-6 && Math.abs(k[0].end - 5.6) < 1e-6, JSON.stringify(k));
  toets('kaart bij shot 3 volgt de ingekorte tijdlijn', Math.abs(k[1].start - 7.7) < 1e-6, JSON.stringify(k));
  toets('kaart bij een onbekend shot vervalt', k.length === 2);
  const onderHook = planKaartenOpTijdlijn(segmenten, [{ shot: 1, tekst: 'vroeg' }], 2.4);
  toets('nooit onder de hookkaart', onderHook[0].start >= 2.4, JSON.stringify(onderHook));
}

console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
process.exit(gefaald === 0 ? 0 : 1);
