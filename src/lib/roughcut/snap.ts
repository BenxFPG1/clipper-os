export type SnapSegment = { start_seconds: number; end_seconds: number; text: string };
export type SnapShot = { start: number; end: number; functie?: string };
export type Stilte = { start: number; end: number };

/**
 * Schuift knippunten naar de dichtstbijzijnde spraakgrens.
 *
 * Het model kiest tijdcodes op basis van het transcript, maar noteert ze op de
 * seconde nauwkeurig. Gemeten op een echt plan viel daardoor 100% van de
 * knippen midden in een gesproken segment: je hoort een half woord aan het
 * begin en het einde wordt afgekapt. Dat is precies waarom een montage "niet
 * overeenkomt met het script" terwijl de tekst wél klopt.
 *
 * De correctie is puur mechanisch — geen AI-call — en houdt zich aan drie
 * regels:
 * 1. Alleen schuiven binnen een klein venster; anders verplaatsen we de inhoud
 *    in plaats van hem netjes af te bakenen.
 * 2. Bij het begin liever iets eerder dan later: een woord te veel is niet erg,
 *    een half woord wel.
 * 3. Aan het einde altijd tot ná het laatste woord, plus een korte uitloop
 *    zodat de zin kan uitademen voor de volgende knip komt.
 */
export function snapShots<T extends SnapShot>(
  shots: T[],
  transcript: SnapSegment[],
  opties: {
    venster?: number;
    inloop?: number;
    uitloop?: number;
    duur?: number | null;
    /** Gemeten spraakpauzes; veruit het betrouwbaarste signaal. */
    stiltes?: Stilte[];
  } = {},
): T[] {
  const stiltes = opties.stiltes ?? [];
  if (transcript.length === 0 && stiltes.length === 0) return shots;

  const venster = opties.venster ?? 2.0;
  const inloop = opties.inloop ?? 0.08;
  const uitloop = opties.uitloop ?? 0.18;
  const maxDuur = opties.duur ?? Infinity;

  // Stiltes zijn gemeten uit de audio zelf en dus precies; transcriptgrenzen
  // zijn een grove terugval (YouTube-ondertitels zijn rollende blokken van
  // meerdere seconden die elkaar overlappen).
  const startGrenzen = stiltes.length
    ? stiltes.map((s) => s.end) // spraak begint waar de stilte eindigt
    : transcript.map((s) => s.start_seconds);
  const eindGrenzen = stiltes.length
    ? stiltes.map((s) => s.start) // spraak stopt waar de stilte begint
    : transcript.map((s) => s.end_seconds);
  const starts = [...startGrenzen].sort((a, b) => a - b);
  const einden = [...eindGrenzen].sort((a, b) => a - b);

  return shots.map((shot) => {
    const start = dichtstbij(starts, shot.start, venster, 'eerder');
    const eind = dichtstbij(einden, shot.end, venster, 'later');

    const nieuweStart = Math.max(0, (start ?? shot.start) - inloop);
    const nieuwEind = Math.min(maxDuur, (eind ?? shot.end) + uitloop);

    // Nooit een shot omdraaien of leegmaken door het schuiven.
    if (nieuwEind - nieuweStart < 0.4) return shot;
    return { ...shot, start: nieuweStart, end: nieuwEind };
  });
}

/**
 * Zoekt de dichtstbijzijnde grens binnen het venster. `voorkeur` bepaalt welke
 * kant wint bij gelijke afstand: aan het begin willen we liever te vroeg, aan
 * het einde liever te laat.
 */
function dichtstbij(
  grenzen: number[],
  doel: number,
  venster: number,
  voorkeur: 'eerder' | 'later',
): number | null {
  let beste: number | null = null;
  let besteAfstand = Infinity;

  for (const g of grenzen) {
    const afstand = Math.abs(g - doel);
    if (afstand > venster) continue;
    const isBeter =
      afstand < besteAfstand - 0.001 ||
      (Math.abs(afstand - besteAfstand) <= 0.001 &&
        (voorkeur === 'eerder' ? g < (beste ?? Infinity) : g > (beste ?? -Infinity)));
    if (isBeter) {
      beste = g;
      besteAfstand = afstand;
    }
  }
  return beste;
}
