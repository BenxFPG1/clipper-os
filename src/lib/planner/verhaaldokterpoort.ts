import type { ClipPlan } from './schema';

/**
 * De mechanische kant van de verhaaldokter: geen oordeel, wel meetbare
 * signalen die de LLM-pas moet naar aanleiding daarvan checken. Dezelfde les
 * als bij de montage- en scriptpoort — een taalmodel oordeelt goed over
 * verhaal maar laat meetbare patronen door omdat ze er "goed uitzien". Een
 * "omslag" die woord-voor-woord de "payoff" herhaalt ziet er in de output
 * prima uit; alleen een woordvergelijking ziet dat het geen echte wending
 * beschrijft, maar een parafrase van de uitkomst.
 *
 * Bewust signalen, geen harde fouten: n-gram-overlap is een ruwe maat, en een
 * omslag mag best dicht bij de payoff liggen als de wending zelf klopt. Het
 * rapport is een aanwijzing waar de verhaaldokter moet kijken, geen
 * blokkade.
 */

export type VerhaaldokterSignaal = {
  clipIndex: number;
  titel: string;
  signaal: string;
};

export type VerhaaldokterRapport = {
  signalen: VerhaaldokterSignaal[];
};

/** Frasen die stakes benoemen zonder ze concreet te maken. */
const VAGE_STAKES = ['belangrijk', 'interessant', 'bijzonder', 'opvallend', 'de moeite waard', 'best wel wat'];

const woordenVan = (t: string): Set<string> =>
  new Set(
    t
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter((w) => w.length > 3),
  );

/** Fractie van de woorden in `a` die ook in `b` voorkomen. */
function overlap(a: string, b: string): number {
  const wa = woordenVan(a);
  const wb = woordenVan(b);
  if (wa.size === 0) return 0;
  let gedeeld = 0;
  for (const w of wa) if (wb.has(w)) gedeeld++;
  return gedeeld / wa.size;
}

export function keurVerhaaldokter(plan: ClipPlan): VerhaaldokterRapport {
  const signalen: VerhaaldokterSignaal[] = [];

  plan.clips.forEach((clip, i) => {
    const { belofte, payoff, omslag } = clip.verhaallijn;

    const payoffOverlap = overlap(omslag, payoff);
    if (payoffOverlap > 0.6) {
      signalen.push({
        clipIndex: i,
        titel: clip.titel_intern,
        signaal: `"omslag" overlapt sterk met "payoff" (${Math.round(payoffOverlap * 100)}% van de woorden) — beschrijft dit echt wat de kijker vlak vóór de payoff dacht, of is het een parafrase van de uitkomst zelf?`,
      });
    }

    const vaag = VAGE_STAKES.filter((w) => belofte.toLowerCase().includes(w) || omslag.toLowerCase().includes(w));
    if (vaag.length > 0) {
      signalen.push({
        clipIndex: i,
        titel: clip.titel_intern,
        signaal: `vage stakes-taal ("${vaag.join('", "')}") in plaats van een concreet belang — geld, geloofwaardigheid, een relatie, een overtuiging?`,
      });
    }
  });

  // Cross-clip: twee clips met (bijna) dezelfde omslag zijn één format twee
  // keer verteld, geen twee verhalen.
  for (let i = 0; i < plan.clips.length; i++) {
    for (let j = i + 1; j < plan.clips.length; j++) {
      const gedeeld = overlap(plan.clips[i].verhaallijn.omslag, plan.clips[j].verhaallijn.omslag);
      if (gedeeld > 0.5) {
        signalen.push({
          clipIndex: i,
          titel: plan.clips[i].titel_intern,
          signaal: `omslag lijkt sterk op clip "${plan.clips[j].titel_intern}" (${Math.round(gedeeld * 100)}% van de woorden) — een echt andere wending, of hetzelfde patroon twee keer?`,
        });
      }
    }
  }

  return { signalen };
}

/** Compact voor in een prompt: de verhaaldokter checkt deze punten expliciet. */
export function rapportVoorPrompt(rapport: VerhaaldokterRapport): string {
  if (rapport.signalen.length === 0) return '';
  return `\n\n=== MECHANISCHE SIGNALEN (geen oordeel — wel de moeite van het checken) ===\n${rapport.signalen
    .map((s) => `clip ${s.clipIndex + 1} "${s.titel}": ${s.signaal}`)
    .join('\n')}`;
}
