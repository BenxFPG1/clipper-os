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
    /**
     * Staan de grenzen al op het woord (citaat-uitlijning)? Dan mag het snappen
     * het shot alleen nog verruimen, nooit inkorten. Anders knipt hij woorden
     * weg die wél in het script staan — en dat is precies de klacht: de montage
     * hoort het script letterlijk te volgen.
     */
    alleenVerruimen?: boolean;
    /**
     * Woordgrenzen uit de uitlijning. Terugval als er in de buurt geen
     * spraakpauze ligt: iemand die onafgebroken doorpraat heeft geen stilte om
     * op te knippen, maar tussen twee woorden zit altijd ruimte.
     */
    woordgrenzen?: number[];
  } = {},
): T[] {
  // Alleen pauzes die er echt één zijn. De meting staat op 0,1s minimum, en die
  // korte dipjes zijn geen adempauze maar de sluiting van een medeklinker
  // midden in een woord ("volatiliteit" heeft er drie). Daar knippen klinkt
  // exact als een half afgekapt woord — dit was de oorzaak, niet het zoeken
  // zelf: hij vond keurig een stilte, alleen was het er geen.
  const MIN_PAUZE = 0.25;
  const stiltes = (opties.stiltes ?? []).filter((st) => st.end - st.start >= MIN_PAUZE);
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

  // Na citaat-uitlijning staan de grenzen op het woord, maar dat is niet
  // hetzelfde als op een stílte. Zit de dichtstbijzijnde pauze net buiten het
  // krappe venster, dan bleef de knip midden in de spraak staan — en dat hoor
  // je als een half afgekapt woord. Daarom mag hij nu véél verder zoeken zolang
  // hij alleen maar verruimt: extra ademruimte kost niets, een afgekapt woord
  // wel.
  const zoekVenster = opties.alleenVerruimen ? Math.max(venster, 1.6) : venster;

  const woorden = opties.woordgrenzen ?? [];

  return shots.map((shot) => {
    // Eerst een echte spraakpauze zoeken; die klinkt het schoonst. Lukt dat
    // niet, dan de dichtstbijzijnde woordgrens — nog altijd oneindig veel beter
    // dan midden in een lettergreep.
    const start =
      dichtstbij(starts, shot.start, zoekVenster, 'eerder', opties.alleenVerruimen) ??
      dichtstbij(woorden, shot.start, 0.6, 'eerder', opties.alleenVerruimen);
    const eind =
      dichtstbij(einden, shot.end, zoekVenster, 'later', opties.alleenVerruimen) ??
      dichtstbij(woorden, shot.end, 0.6, 'later', opties.alleenVerruimen);

    let nieuweStart = Math.max(0, (start ?? shot.start) - inloop);
    let nieuwEind = Math.min(maxDuur, (eind ?? shot.end) + uitloop);

    // De gesproken tekst is heilig: eerder beginnen en later stoppen mag, maar
    // de grens naar binnen schuiven kost een woord uit het script.
    if (opties.alleenVerruimen) {
      nieuweStart = Math.min(nieuweStart, shot.start);
      nieuwEind = Math.max(nieuwEind, shot.end);
    }

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
  /** Alleen grenzen accepteren die de kant op liggen die het shot verruimt. */
  alleenRichting = false,
): number | null {
  let beste: number | null = null;
  let besteAfstand = Infinity;

  for (const g of grenzen) {
    const afstand = Math.abs(g - doel);
    if (afstand > venster) continue;
    if (alleenRichting && (voorkeur === 'eerder' ? g > doel : g < doel)) continue;
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

/**
 * Haalt dode lucht wég uit shots: interne stiltes langer dan `maxStilte`
 * worden strak getrokken naar `laat` seconden. Dit is het verschil tussen een
 * edit die loopt en een die sleept (editcraft).
 *
 * Uitzondering: payoff-shots blijven heel. Stilte vlak vóór of ín de
 * onthulling is spanning, geen dode lucht.
 */
export function verwijderDodeLucht<T extends SnapShot & { volgorde?: number }>(
  shots: T[],
  stiltes: Stilte[],
  opties: { maxStilte?: number; laat?: number } = {},
): (T & { subKnip?: boolean })[] {
  // Ruimer dan eerst (0,8s en 0,3s marge). De stiltemeting staat op -32 dB, en
  // een uitklinkende medeklinker of een zachte laatste lettergreep zakt daar
  // al onder. Knipte je dan strak op die grens, dan verdween het staartje van
  // een woord — precies de klacht dat er middenin een woord geknipt wordt.
  // Alleen echt lange pauzes wegnemen, en ruim ademruimte laten staan.
  const maxStilte = opties.maxStilte ?? 1.1;
  const laat = opties.laat ?? 0.55;
  if (stiltes.length === 0) return shots;

  const uit: (T & { subKnip?: boolean })[] = [];

  for (const shot of shots) {
    if (shot.functie === 'payoff') {
      uit.push(shot);
      continue;
    }

    // Stiltes die ruim bínnen het shot vallen; de randen zijn al door het
    // snappen afgehandeld.
    const binnen = stiltes
      .filter((st) => st.start > shot.start + 0.6 && st.end < shot.end - 0.6 && st.end - st.start > maxStilte)
      .sort((a, b) => a.start - b.start);

    if (binnen.length === 0) {
      uit.push(shot);
      continue;
    }

    let cursor = shot.start;
    for (const st of binnen) {
      // Stukje vóór de stilte, plus een klein restje stilte als ademruimte.
      uit.push({ ...shot, start: cursor, end: st.start + laat / 2, subKnip: cursor !== shot.start });
      cursor = st.end - laat / 2;
    }
    uit.push({ ...shot, start: cursor, end: shot.end, subKnip: true });
  }

  // Volgorde opnieuw doornummeren zodat de rest van de keten er niets van merkt.
  return uit.map((s, i) => ({ ...s, volgorde: i + 1 }));
}
