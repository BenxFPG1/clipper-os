/**
 * Tests voor de scriptpoort: de meetbare regels waarop echte scripts eerder
 * doorheen zijn geglipt. Elke test hier is een fout die daadwerkelijk in een
 * goedgekeurd script heeft gezeten.
 *
 * Draaien: npm run test:scriptpoort
 */
import { keurScriptTekst } from '../src/lib/scriptwriter/poort';
import type { Script } from '../src/lib/scriptwriter';

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

function basisScript(overrides: Partial<Script> = {}): Script {
  return {
    concept: 'test',
    structure_type: 'cold_open_flashback',
    verhaallijn: {
      belofte: 'Je hoort de zin die hem stil kreeg.',
      open_vraag: 'Wat zei de gast waardoor hij stilviel?',
      escalatie: ['Eerst lacht hij nog, MAAR dan corrigeert de gast hem.', 'DUS vraagt hij door, en het wordt groter.'],
      payoff: 'De zin zelf, onverknipt.',
      rode_draad: 'Eén vraag die pas aan het einde dichtgaat.',
    },
    hook: {
      type: 'vonnis_zonder_context',
      tekst_overlay: 'Wat zegt zijn gast hier?',
      gesproken: 'Nee. Wacht. Zeg dat nog een keer.',
      waarom: 'test',
    },
    shotlist: [
      { volgorde: 1, seconde_van: 0, seconde_tot: 1.5, functie: 'hook', beeld: 'x', gesproken_tekst: 'Nee. Wacht. Zeg dat eens.', tekst_in_beeld: null, edit_notitie: '' },
      { volgorde: 2, seconde_van: 1.5, seconde_tot: 8, functie: 'escalatie', beeld: 'x', gesproken_tekst: 'Veertig seconden eerder stelde ik een routinevraag.', tekst_in_beeld: null, edit_notitie: '' },
      { volgorde: 3, seconde_van: 8, seconde_tot: 14, functie: 'payoff', beeld: 'x', gesproken_tekst: 'En toen zei ze het gewoon.', tekst_in_beeld: null, edit_notitie: '' },
    ],
    caption: { tiktok: 'Wat had jij gezegd?', reels: 'Wat had jij gezegd?', shorts: 'Wat had jij gezegd?' },
    hashtags: [],
    benodigdheden: [],
    varianten: [
      { aanpak: 'a', hook_tekst: 'x', wijziging: 'y' },
      { aanpak: 'b', hook_tekst: 'x', wijziging: 'y' },
    ],
    risico: 'geen',
    onderbouwing: 'test',
    ...overrides,
  } as Script;
}

console.log('schoon script passeert');
{
  const r = keurScriptTekst(basisScript(), { duurSeconden: 15 });
  toets('geen fouten', r.goed, r.fouten.join('; '));
}

console.log('placeholders blokkeren');
{
  const s = basisScript();
  s.shotlist[2].gesproken_tekst = 'Gast: [DE ZIN — het letterlijke antwoord].';
  const r = keurScriptTekst(s);
  toets('placeholder is een fout', !r.goed && r.fouten.some((f) => f.includes('placeholder')));
}

console.log('woordbudget');
{
  const s = basisScript();
  s.shotlist[0].gesproken_tekst =
    'Dit is een veel te lange zin met heel erg veel woorden die nooit van zijn leven in anderhalve seconde uitgesproken kan worden door wie dan ook.';
  const r = keurScriptTekst(s);
  toets('te veel woorden per seconde is een fout', !r.goed && r.fouten.some((f) => f.includes('woorden')));
}

console.log('aankondigingen en verzonnen bewijs');
{
  const s = basisScript();
  s.shotlist[1].gesproken_tekst = 'Dan komt het detail waar de comments ontploften. Kijk mee.';
  const r = keurScriptTekst(s, { briefing: 'gewone briefing' });
  toets('aankondiging is een fout', r.fouten.some((f) => f.includes('kijk mee')));
  toets('verzonnen bewijs is een fout', r.fouten.some((f) => f.includes('comments ontploften')));
}
{
  const s = basisScript();
  s.shotlist[1].gesproken_tekst = 'De comments ontploften — dat stond zelfs in het AD.';
  const r = keurScriptTekst(s, { briefing: 'De comments ontploften vorige week echt, zie link.' });
  toets('bewijs uit de briefing mag wel', !r.fouten.some((f) => f.includes('comments ontploften')));
}

console.log('genummerde bewijskaarten');
{
  const s = basisScript();
  s.shotlist[1].tekst_in_beeld = 'BEWIJS 2';
  const r = keurScriptTekst(s);
  toets('BEWIJS 2 is een fout', r.fouten.some((f) => f.includes('genummerde kaart')));
}

console.log('niets substantieels na de payoff');
{
  const s = basisScript();
  s.shotlist.push({ volgorde: 4, seconde_van: 14, seconde_tot: 18, functie: 'escalatie', beeld: 'x', gesproken_tekst: 'En er was nog iets.', tekst_in_beeld: null, edit_notitie: '' } as never);
  const r = keurScriptTekst(s);
  toets('escalatie na payoff is een fout', r.fouten.some((f) => f.includes('na de payoff')));
}

console.log('waarschuwingen');
{
  const s = basisScript();
  s.caption.tiktok = 'Een beschrijving zonder vraag';
  const r = keurScriptTekst(s);
  toets('caption zonder vraag is een verhoorpunt', r.waarschuwingen.some((w) => w.includes('caption')));
}
{
  const s = basisScript();
  s.verhaallijn.escalatie = ['Dit gebeurde.', 'En toen dit.'];
  const r = keurScriptTekst(s);
  toets('escalatie zonder maar/dus is een verhoorpunt', r.waarschuwingen.some((w) => w.includes('maar')));
}

console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
process.exit(gefaald === 0 ? 0 : 1);
