export const KADERS = ['staand', 'vullend', 'blur', 'origineel'] as const;
export type Kader = (typeof KADERS)[number];

/**
 * Hoe het 16:9-beeld in een verticaal kader komt. Eén vaste keuze maakt alle
 * clips op elkaar lijken; daarom is dit per clip in te stellen.
 *
 * - staand: beeld op volle breedte, hoog in het kader, rustige donkere ruimte
 *   eronder voor ondertiteling en tekstkaarten. Niets wordt weggesneden en er
 *   is geen blur nodig. Dit is de standaard.
 * - vullend: beeld gevuld met een uitsnede. Strak en modern, maar snijdt de
 *   zijkanten weg — alleen als het onderwerp midden in beeld staat.
 * - blur: de vertrouwde geblurde uitvergroting als achtergrond. Werkt altijd,
 *   maar valt op als je hem overal gebruikt.
 * - origineel: geen verticale conversie; houdt 16:9 aan voor YouTube of als je
 *   zelf wilt kadreren in Premiere.
 */
export function kaderFilter(kader: Kader): string[] {
  if (kader === 'origineel') return [];

  if (kader === 'vullend') {
    return [
      '-vf',
      'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p',
    ];
  }

  if (kader === 'blur') {
    // De achtergrond wordt tóch onscherp, dus blurren op klein formaat en
    // daarna opschalen: visueel gelijk, een fractie van het rekenwerk.
    return [
      '-vf',
      'split[a][b];[a]scale=192:342:force_original_aspect_ratio=increase,crop=192:342,boxblur=6:2,scale=1080:1920[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p',
    ];
  }

  // staand: beeld op volle breedte (1080x608), bovenrand op 18% van de hoogte.
  // Dat laat ruim 700px onderin vrij voor ondertiteling zonder dat je iets
  // wegsnijdt, en het oogt rustiger dan een blurvlak.
  return [
    '-vf',
    'scale=1080:-2,pad=1080:1920:(ow-iw)/2:300:color=#0B0B0F,format=yuv420p',
  ];
}

/**
 * Kiest een kader als het plan er geen opgeeft. Bewust afwisselend: drie clips
 * achter elkaar in exact hetzelfde kader zien er als één serie uit, en dat is
 * precies de eentonigheid die opvalt.
 */
export function standaardKader(clipIndex: number): Kader {
  return clipIndex % 3 === 2 ? 'vullend' : 'staand';
}
