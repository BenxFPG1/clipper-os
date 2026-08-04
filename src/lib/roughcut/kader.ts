export const KADERS = ['vullend', 'blur', 'staand', 'origineel'] as const;
export type Kader = (typeof KADERS)[number];

/**
 * Hoe het 16:9-beeld in een verticaal kader komt.
 *
 * - vullend (standaard): beeld gevuld met een uitsnede, met per shot een
 *   focuspunt zodat de spreker in beeld blijft. Verticaal beeld hoort gevuld;
 *   zwarte vlakken lezen als onafgemaakt (editcraft).
 * - blur: geblurde uitvergroting als achtergrond. Alleen op verzoek.
 * - staand: letterbox met ruimte voor ondertiteling. Alleen als bewuste stijl,
 *   nooit automatisch — als losse keuze zag dit er onafgemaakt uit.
 * - origineel: geen conversie (YouTube, of zelf kadreren in Premiere).
 */
export function kaderKeten(
  kader: Kader,
  opties: { focusX?: number; zoom?: number } = {},
): string {
  const zoom = opties.zoom ?? 1;
  // Focus 0..1: waar de uitsnede horizontaal op richt (0 = links, 1 = rechts).
  const f = Math.min(1, Math.max(0, opties.focusX ?? 0.5)).toFixed(3);

  if (kader === 'origineel') return 'null';

  if (kader === 'blur') {
    return 'split[a][b];[a]scale=192:342:force_original_aspect_ratio=increase,crop=192:342,boxblur=6:2,scale=1080:1920[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p';
  }

  if (kader === 'staand') {
    return 'scale=1080:-2,pad=1080:1920:(ow-iw)/2:300:color=#0B0B0F,format=yuv420p';
  }

  // vullend: hoogte vullen (maal de zoom voor punch-ins), dan de uitsnede op
  // het focuspunt leggen. De klem in de x-expressie voorkomt dat de uitsnede
  // buiten beeld schuift bij focus hard links of rechts.
  const hoogte = Math.round((1920 * zoom) / 2) * 2;
  return (
    `scale=-2:${hoogte},` +
    `crop=1080:1920:min(max((iw-1080)*${f}\\,0)\\,iw-1080):(ih-1920)/2,` +
    'format=yuv420p'
  );
}

/** Zet het focus-veld uit het plan om naar een horizontale positie. */
export function focusNaarX(focus?: string | null, gemeten?: number | null): number {
  if (focus === 'links') return 0.18;
  if (focus === 'rechts') return 0.82;
  if (focus === 'midden') return 0.5;
  // Geen scriptkeuze: gemeten gezichtspositie, anders het midden.
  return gemeten ?? 0.5;
}
