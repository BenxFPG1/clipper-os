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
  opties: {
    focusX?: number;
    zoom?: number;
    focusY?: number;
    /** Meelopend focuspunt (ffmpeg-expressie in t); wint van focusX. */
    focusExpr?: string;
    /** Verticale variant; wint van focusY. */
    focusYExpr?: string;
  } = {},
): string {
  const zoom = opties.zoom ?? 1;
  // Focus 0..1: waar de uitsnede horizontaal op richt (0 = links, 1 = rechts).
  const f = opties.focusExpr ?? Math.min(1, Math.max(0, opties.focusX ?? 0.5)).toFixed(3);

  if (kader === 'origineel') return 'null';

  if (kader === 'blur') {
    return 'split[a][b];[a]scale=192:342:force_original_aspect_ratio=increase,crop=192:342,boxblur=6:2,scale=1080:1920[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p';
  }

  // vullend: hoogte vullen (maal de zoom voor punch-ins), dan de uitsnede op
  // het focuspunt leggen. De klem in de x-expressie voorkomt dat de uitsnede
  // buiten beeld schuift bij focus hard links of rechts.
  const hoogte = Math.round((1920 * zoom) / 2) * 2;
  // Verticaal: standaard het midden, maar met een focusY leggen we de ogen op
  // ongeveer een derde van boven. Een sprekend hoofd hoort daar; precies
  // gecentreerd geeft te veel lucht boven en een kin tegen de onderrand.
  const fy = opties.focusYExpr ?? Math.min(1, Math.max(0, opties.focusY ?? 0.5)).toFixed(3);
  return (
    `scale=-2:${hoogte},` +
    // Horizontaal net als verticaal: het focuspunt is het middelpunt van de
    // uitsnede. Zo betekent focusX overal hetzelfde — in de meting, in de
    // controle en hier in de render.
    `crop=1080:1920:min(max(iw*${f}-540\\,0)\\,iw-1080):min(max(ih*${fy}-960\\,0)\\,ih-1920),` +
    'format=yuv420p'
  );
}

/**
 * Waar de uitsnede horizontaal op richt.
 *
 * De gemeten gezichtspositie wint van wat het plan of de edit-agent opgeeft.
 * Die agents zien de video niet — ze leiden "links" of "rechts" af uit de
 * tekst, en zaten er in de praktijk zo vaak naast dat de spreker helemaal
 * buiten beeld viel. De meting is echte data uit het beeld zelf.
 *
 * De opgegeven focus blijft wel meetellen als er niets te meten viel (geen
 * gezicht gevonden, bijvoorbeeld bij een shot van een grafiek of een hand).
 */
export function focusNaarX(focus?: string | null, gemeten?: number | null): number {
  if (typeof gemeten === 'number') return gemeten;
  if (focus === 'links') return 0.18;
  if (focus === 'rechts') return 0.82;
  if (focus === 'midden') return 0.5;
  return 0.5;
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

/**
 * Bouwt een ffmpeg-expressie die het focuspunt over de tijd laat meelopen met
 * de spreker.
 *
 * Waarom volgen en niet uitzoomen: beweegt iemand door het beeld, of neemt de
 * ander halverwege het woord over, dan is de keuze anders "zo ver uitzoomen dat
 * beide uitersten passen" — en dan staat er niemand meer groot in beeld. Een
 * meelopende uitsnede houdt de spreker groot én in beeld.
 *
 * Tussen de meetpunten wordt lineair geïnterpoleerd; de punten zelf zijn al
 * gladgestreken en in snelheid begrensd, zodat de beweging vloeiend is en niet
 * schokt op elke meetfout.
 */
export function spoorExpressie(spoor: { t: number; x: number }[]): string | null {
  if (spoor.length < 2) return null;

  const p = [...spoor].sort((a, b) => a.t - b.t);
  const v = (n: number) => n.toFixed(4);

  // Van achter naar voren opbouwen: de laatste waarde is de terugval, en elke
  // stap zet er een "voor dit tijdvak geldt deze lijn" omheen.
  let expr = v(p[p.length - 1].x);
  for (let i = p.length - 2; i >= 0; i--) {
    const a = p[i];
    const b = p[i + 1];
    const duur = Math.max(0.001, b.t - a.t);
    const lijn = `(${v(a.x)}+(${v(b.x - a.x)})*(t-${v(a.t)})/${v(duur)})`;
    expr = `if(lt(t\\,${v(b.t)})\\,${lijn}\\,${expr})`;
  }
  return expr;
}

/**
 * Maakt van ruwe metingen een bruikbaar spoor: gaten opvullen, gladstrijken en
 * de snelheid begrenzen.
 *
 * De snelheidslimiet is het verschil tussen een camera die meebeweegt en een
 * beeld dat heen en weer springt. Neemt de gesprekspartner het woord over, dan
 * is dat een sprong van een halve beeldbreedte; die wordt hier een pan van een
 * seconde of twee in plaats van een schok van één frame.
 */
export function maakSpoor(
  metingen: { t: number; x: number | null }[],
  opties: { maxSnelheid?: number; demping?: number } = {},
): { t: number; x: number }[] {
  const maxSnelheid = opties.maxSnelheid ?? 0.22; // fractie beeldbreedte per seconde
  const demping = opties.demping ?? 0.45;

  // Gaten opvullen met de laatst bekende positie; blijft het begin leeg, dan
  // pakken we de eerste meting die er wel is.
  const eerste = metingen.find((m) => m.x !== null)?.x ?? 0.5;
  let vorige = eerste;
  const gevuld = metingen.map((m) => {
    if (m.x !== null) vorige = m.x;
    return { t: m.t, x: vorige };
  });

  // Gladstrijken met een lopend gemiddelde over drie punten: haalt de ruis van
  // de detectie eruit zonder de beweging zelf plat te slaan.
  const glad = gevuld.map((m, i) => {
    const buren = [gevuld[i - 1], m, gevuld[i + 1]].filter(Boolean) as { t: number; x: number }[];
    return { t: m.t, x: buren.reduce((som, b) => som + b.x, 0) / buren.length };
  });

  // Volgen met demping en een snelheidsplafond. Het eerste punt is de gemeten
  // positie zelf, niet het gladgestreken gemiddelde: een shot moet meteen goed
  // staan. Met een aanloop stond de spreker de eerste seconde links in beeld
  // terwijl het kader nog bijtrok — precies wat er aan het begin van het
  // slotshot te zien was.
  const uit: { t: number; x: number }[] = [];
  let positie = gevuld[0].x;
  for (const [i, punt] of glad.entries()) {
    const dt = i === 0 ? 0 : punt.t - glad[i - 1].t;
    const doel = punt.x;
    const stap = (doel - positie) * demping;
    const plafond = maxSnelheid * Math.max(dt, 0.001);
    positie += Math.max(-plafond, Math.min(plafond, stap));
    uit.push({ t: punt.t, x: Math.min(1, Math.max(0, positie)) });
  }
  return uit;
}
