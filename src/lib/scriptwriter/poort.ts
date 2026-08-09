import type { Script } from './index';

/**
 * De scriptpoort: mechanische controle op de meetbare regels van een script.
 *
 * Dezelfde les als bij de montage. Een LLM-examinator oordeelt goed over
 * verhaal en stijl, maar laat meetbare fouten door omdat ze er "goed uitzien":
 * een shot van 4 seconden met 25 woorden gesproken tekst, een placeholder
 * tussen blokhaken, een aankondiging die zich als spanning voordoet. In de
 * praktijk gebeurde precies dat — het examen keurde een script goed waarvan de
 * payoff letterlijk "[DE ZIN]" was.
 *
 * Alles wat hier staat is telbaar en heeft geen smaak nodig. Fouten blokkeren;
 * waarschuwingen gaan als verhoorpunten mee naar de examinator. Het rapport
 * reist met het script mee zodat in het dashboard te zien is waarop getoetst
 * is.
 */

export type ScriptPoortRapport = {
  goed: boolean;
  fouten: string[];
  waarschuwingen: string[];
};

/** Gesproken Nederlands haalt 2,5-3 woorden per seconde; wij rekenen ruim. */
const WOORDEN_PER_SECONDE = 3.0;

/** Frasen die aankondigen in plaats van tonen. */
const AANKONDIGINGEN = [
  'kijk mee',
  'kijk wat er gebeurt',
  'let op wat',
  'je gelooft nooit',
  'wacht tot',
  'wat er dan gebeurt',
  'dit moet je zien',
  'blijf kijken',
];

/** Verzonnen sociale bewijskracht; alleen toegestaan als de briefing het staaft. */
const VERZONNEN_BEWIJS = [
  'comments ontploften',
  'ging viral',
  'iedereen had het erover',
  'het internet',
  'heel nederland sprak',
];

const woorden = (t: string) =>
  t
    .replace(/\[[^\]]*\]/g, '')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

export function keurScriptTekst(
  script: Script,
  opties: { duurSeconden?: number | null; briefing?: string } = {},
): ScriptPoortRapport {
  const fouten: string[] = [];
  const waarschuwingen: string[] = [];
  const briefing = (opties.briefing ?? '').toLowerCase();

  // 1. Placeholders: elk woord moet uitspreekbaar zijn. Een script met
  //    "[FRAGMENT A]" is een sjabloon, en sjablonen zijn eerder doorgelaten
  //    als ware het scripts.
  for (const shot of script.shotlist) {
    const blokken = shot.gesproken_tekst.match(/\[[A-Z][^\]]{2,}\]/g);
    if (blokken) {
      fouten.push(
        `shot ${shot.volgorde}: placeholder in gesproken tekst (${blokken.join(', ')}) — elk woord moet uitspreekbaar zijn`,
      );
    }
  }

  // 2. Woordbudget per shot: de mond is de maat.
  for (const shot of script.shotlist) {
    const duur = shot.seconde_tot - shot.seconde_van;
    if (duur <= 0) {
      fouten.push(`shot ${shot.volgorde}: duur van ${duur}s`);
      continue;
    }
    const aantal = woorden(shot.gesproken_tekst);
    const budget = Math.ceil(duur * WOORDEN_PER_SECONDE);
    if (aantal > budget) {
      fouten.push(
        `shot ${shot.volgorde}: ${aantal} woorden in ${duur.toFixed(1)}s — een mond haalt er ${budget}`,
      );
    }
  }

  // 3. Aankondigingen en verzonnen bewijs.
  const alleTekst = [
    ...script.shotlist.map((s) => `${s.gesproken_tekst} ${s.tekst_in_beeld ?? ''}`),
    script.hook.gesproken,
    script.hook.tekst_overlay,
  ]
    .join(' ')
    .toLowerCase();
  for (const frase of AANKONDIGINGEN) {
    if (alleTekst.includes(frase)) {
      fouten.push(`aankondiging in plaats van spanning: "${frase}"`);
    }
  }
  for (const frase of VERZONNEN_BEWIJS) {
    if (alleTekst.includes(frase) && !briefing.includes(frase)) {
      fouten.push(`verzonnen sociale bewijskracht: "${frase}" staat niet in de briefing`);
    }
  }

  // 4. Genummerde bewijskaarten: een opsomming verkleed als verhaal.
  for (const shot of script.shotlist) {
    if (/\b(bewijs|feit|reden|stap)\s*[0-9]\b/i.test(shot.tekst_in_beeld ?? '')) {
      fouten.push(`shot ${shot.volgorde}: genummerde kaart ("${shot.tekst_in_beeld}") — opsomming, geen verhaal`);
    }
  }

  // 5. De hook: kort genoeg om binnen 1,5s te landen.
  if (woorden(script.hook.gesproken) > 12) {
    waarschuwingen.push(`hook is ${woorden(script.hook.gesproken)} woorden gesproken; binnen 1,5s passen er ~5`);
  }
  if (woorden(script.hook.tekst_overlay) > 10) {
    waarschuwingen.push(`hook-overlay is ${woorden(script.hook.tekst_overlay)} woorden; op een telefoon lees je er in een oogopslag ~8`);
  }

  // 6. Tijdlijn: oplopend, en de totale duur klopt met de briefing.
  let vorigeTot = 0;
  for (const shot of script.shotlist) {
    if (shot.seconde_van < vorigeTot - 0.01) {
      fouten.push(`shot ${shot.volgorde}: begint op ${shot.seconde_van}s, vóór het einde van het vorige shot (${vorigeTot}s)`);
    }
    vorigeTot = shot.seconde_tot;
  }
  if (opties.duurSeconden) {
    const totaal = script.shotlist[script.shotlist.length - 1]?.seconde_tot ?? 0;
    if (totaal > opties.duurSeconden * 1.25 || totaal < opties.duurSeconden * 0.6) {
      waarschuwingen.push(`script duurt ${totaal}s; de briefing vraagt ~${opties.duurSeconden}s`);
    }
  }

  // 7. De payoff hoort achterin; alles erna is hooguit één button.
  const payoffIndex = script.shotlist.findIndex((s) => s.functie === 'payoff');
  if (payoffIndex >= 0 && payoffIndex < script.shotlist.length * 0.5) {
    waarschuwingen.push('de payoff valt in de eerste helft — daarna is de clip af, wat er ook nog komt');
  }
  const naPayoff = script.shotlist.filter((s, i) => i > payoffIndex && s.functie !== 'payoff' && s.functie !== 'button');
  if (payoffIndex >= 0 && naPayoff.length > 0) {
    fouten.push(`${naPayoff.length} shot(s) na de payoff die geen button zijn — elke seconde na de payoff kost kijkers`);
  }

  // 8. Captions zijn vragen.
  for (const [platform, caption] of Object.entries(script.caption)) {
    if (!caption.includes('?')) {
      waarschuwingen.push(`caption voor ${platform} is geen vraag: "${caption.slice(0, 50)}"`);
    }
  }

  // 9. Escalatie draagt causaliteit: ergens moet "maar" of "dus" staan.
  const escalatieTekst = script.verhaallijn.escalatie.join(' ').toLowerCase();
  if (!/(maar|dus)\b/.test(escalatieTekst)) {
    waarschuwingen.push('geen "maar" of "dus" in de escalatie — mogelijk een opsomming in plaats van causaliteit');
  }

  return { goed: fouten.length === 0, fouten, waarschuwingen };
}

/** Compact voor in een prompt: de examinator verhoort op deze punten. */
export function rapportVoorPrompt(rapport: ScriptPoortRapport): string {
  if (rapport.goed && rapport.waarschuwingen.length === 0) return '';
  return `\n\n=== MECHANISCHE KEURING VAN HET CONCEPT (herstel dit expliciet) ===\n${[
    ...rapport.fouten.map((f) => `FOUT: ${f}`),
    ...rapport.waarschuwingen.map((w) => `VERHOOR: ${w}`),
  ].join('\n')}`;
}
