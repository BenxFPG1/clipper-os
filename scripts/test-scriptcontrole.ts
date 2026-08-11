/**
 * Tests voor vindKopIndex: de kern van zowel de aanloop-detectie als "script
 * gevolgd" in scriptcontrole.ts. Elke test hier is een fout die daadwerkelijk
 * een goede render heeft afgekeurd — geen synthetisch scenario, maar de echte
 * clips (GoldRepublic/PLATINA) waarop dit is gevonden.
 *
 * Puur op woordreeksen, geen audio/whisper nodig — vandaar hier en niet in
 * een render-test.
 *
 * Draaien: npm run test:scriptcontrole
 */
import { vindKopIndex } from '../src/lib/roughcut/scriptcontrole';

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

/** Bouwt een woordenreeks van getranscribeerde tekst; elk woord 0,4s. */
function woordenVan(tekst: string): { w: string; n: string; s: number }[] {
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return tekst.split(/\s+/).map((w, i) => ({ w, n: norm(w), s: i * 0.4 }));
}

console.log('fragment dat met een kort woordje begint (en, is, er)');
{
  // Precies clip 2 van GoldRepublic: het fragment IS de scripttekst, geen
  // aanloop. "en" en "is" en "er" zijn allemaal onder de 3 letters.
  const woorden = woordenVan('En dan is er nog het waterstofverhaal vandaag');
  const idx = vindKopIndex('En dan is er nog het waterstofverhaal.', woorden, 30);
  toets('vindt index 0, niet pas bij "waterstofverhaal"', idx === 0, `idx=${idx}`);
}

console.log('koppelteken in de scripttekst');
{
  // Precies clip 5: "Platina-markt" in het plan, "platina markt" (los) zoals
  // whisper het transcribeert.
  const woorden = woordenVan('de platina markt heeft in tweeduizend zesentwintig');
  const idx = vindKopIndex('De Platina-markt heeft in 2026.', woorden);
  toets('splitst het koppelteken en vindt index 0', idx === 0, `idx=${idx}`);
}

console.log('echte aanloop blijft gewoon gevonden, ná de rommel');
{
  // Er zit hier wél overtollig bronmateriaal vóór de scripttekst — dat moet
  // de functie niet wegpoetsen.
  const woorden = woordenVan('ja precies dat denk ik ook goud staat op recordhoogte vandaag');
  const idx = vindKopIndex('Goud staat op recordhoogte.', woorden, 30);
  toets('vindt de echte start, niet index 0', idx !== null && idx > 0, `idx=${idx}`);
  toets('vindt hem exact op "goud"', woorden[idx as number]?.n === 'goud');
}

console.log('kort fragment (<2 woorden) crasht niet');
{
  const woorden = woordenVan('een enkel woord hier');
  const idx = vindKopIndex('Ja.', woorden);
  toets('geen crash, null of een geldige index', idx === null || (idx >= 0 && idx < woorden.length));
}

console.log('fragment dat nergens in de woordenreeks voorkomt');
{
  const woorden = woordenVan('dit gaat over een compleet ander onderwerp vandaag');
  const idx = vindKopIndex('Onvindbare zin die niet klinkt.', woorden);
  toets('levert null, geen valse hit', idx === null, `idx=${idx}`);
}

console.log('limiet beperkt de zoekruimte (voor de aanloop-check)');
{
  // Het kopwoord staat pas ver na de limiet — daarbinnen mag hij niet
  // gevonden worden (zo hoort de aanloop-check alleen naar het bégin te
  // kijken, niet naar de rest van de clip).
  const lang = Array.from({ length: 40 }, (_, i) => `vulwoord${i}`).join(' ');
  const woorden = woordenVan(`${lang} specifiekezin hier`);
  const idxBinnenLimiet = vindKopIndex('Specifiekezin hier.', woorden, 30);
  const idxZonderLimiet = vindKopIndex('Specifiekezin hier.', woorden);
  toets('binnen limiet 30: niet gevonden', idxBinnenLimiet === null, `idx=${idxBinnenLimiet}`);
  toets('zonder limiet: wel gevonden', idxZonderLimiet !== null, `idx=${idxZonderLimiet}`);
}

console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
process.exit(gefaald === 0 ? 0 : 1);
