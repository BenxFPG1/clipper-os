export const KADERS = ['vullend', 'blur', 'staand', 'origineel'] as const;
export type Kader = (typeof KADERS)[number];

/**
 * Hoe het 16:9-beeld in een verticaal kader komt.
 *
 * - vullend (standaard): beeld gevuld met een uitsnede, met per shot een
 *   focuspunt zodat de spreker in beeld blijft. Verticaal beeld hoort gevuld;
 *   zwarte vlakken lezen als onafgemaakt (editcraft).
 * - blur: geblurde uitvergroting als achtergrond. Alleen op verzoek.
 * - staand: bestond als letterbox met ruimte voor ondertiteling, maar zonder
 *   ingebrande tekst blijft er een zwart vlak van duizend pixels over en leest
 *   de clip als kapot. Rendert daarom nu hetzelfde als vullend; de edit-agent
 *   kan hem niet meer kiezen.
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

/**
 * Beeldingrepen die niets aan de lengte van een shot veranderen, en dus
 * veilig achter de kaderketen passen. De duur-veranderende ingrepen uit de
 * effectenvault (freeze_frame, speed_ramp, slow_motion) zitten hier bewust
 * niet in: die verschuiven alle tijdcodes daarna, en dan kloppen de sfx,
 * kaarten en muziekstiltes niet meer.
 *
 * Zoom-ingrepen (punch_in, snelle_zoom) worden al door de kaderketen zelf
 * afgehandeld via de zoomfactor.
 */
export function effectKeten(effect?: string | null, duur = 0): string | null {
  if (!effect || effect === 'geen') return null;

  if (effect === 'flits_wit') {
    // Twee frames wit aan het begin van het shot: dekt een harde tijdsprong af.
    return "drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=fill:enable='lt(t,0.067)'";
  }

  if (effect === 'zwart_frame') {
    // Eén ademteug zwart, vlak vóór wat er komt.
    return "drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='lt(t,0.04)'";
  }

  if (effect === 'shake') {
    // Korte trilling die uitdempt (exp), niet langer dan een fractie van een
    // seconde — anders wordt het misselijkmakend (editcraft).
    return (
      'crop=iw-24:ih-24:' +
      "'12+10*sin(t*72)*exp(-t*7)':'12+10*cos(t*61)*exp(-t*7)'," +
      'scale=1080:1920'
    );
  }

  if (effect === 'freeze_frame' && duur > 0) {
    // Het laatste beeld even vasthouden zonder het shot te verlengen: de
    // laatste 0,35s wordt bevroren door de tijd daar stil te zetten.
    const vanaf = Math.max(0, duur - 0.35).toFixed(3);
    return `setpts='if(gte(T\,${vanaf})\,${vanaf}/TB\,PTS)'`;
  }

  return null;
}
