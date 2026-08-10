/**
 * Tests voor de mechanische kant van de verhaaldokter: de metingen waarop de
 * LLM-pas moet doorvragen (parafrase tussen omslag en payoff, vage
 * stakes-taal, cross-clip omslagherhaling). Puur code, geen model — net als
 * de poort en de scriptpoort.
 *
 * Draaien: npm run test:verhaaldokter
 */
import { keurVerhaaldokter, rapportVoorPrompt } from '../src/lib/planner/verhaaldokterpoort';
import type { Clip, ClipPlan } from '../src/lib/planner/schema';

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
      { volgorde: 1, start: 0, end: 3, functie: 'hook', transcript_fragment: 'x', edit_notitie: '' },
      { volgorde: 2, start: 3, end: 10, functie: 'payoff', transcript_fragment: 'y', edit_notitie: '' },
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

console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
process.exit(gefaald === 0 ? 0 : 1);
