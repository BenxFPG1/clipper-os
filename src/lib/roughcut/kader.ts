import { instelling } from './instellingen';

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
    /** Hoogte van het beeld waaruit gesneden wordt (px); bepaalt of er opgeschaald wordt. Standaard 1080. */
    bronHoogte?: number;
    /**
     * Alleen bij blur: het gebied van de bron dat als voorgrond in beeld komt
     * (graphics.ts → inhoudKader) en hoe groot. Zonder dit het hele beeld,
     * passend op volle breedte.
     */
    inhoud?: { r: { x0: number; y0: number; x1: number; y1: number }; fgB: number; fgH: number; y0: number };
    /**
     * Alleen bij een ingezoomde graphic: een langzame push-in over de hele
     * tijd dat hij in beeld staat (duur), met `vanaf` als startpunt voor een
     * los gerenderd deel (het vastgehouden frame loopt door waar de beweging
     * was). Een graphic van elf seconden zonder enige beweging was het
     * zwakste stuk van PLATINA plan-7.1 clip 1.
     */
    beweging?: { duur: number; vanaf: number; fps: number };
    /**
     * Gerichte beweging (graphiclezer.ts): zoompunten in seconden vanaf het
     * begin van dit deel, met hun plek in het bronbeeld. Wint van de
     * gelijkmatige push-in.
     */
    focus?: { t: number; cx: number; cy: number; b: number; h: number }[];
  } = {},
): string {
  const zoom = opties.zoom ?? 1;
  // Focus 0..1: waar de uitsnede horizontaal op richt (0 = links, 1 = rechts).
  const f = opties.focusExpr ?? Math.min(1, Math.max(0, opties.focusX ?? 0.5)).toFixed(3);

  if (kader === 'origineel') return 'null';

  if (kader === 'blur') {
    // Alleen de voorgrond krijgt lanczos: de achtergrond is bewust wazig, daar
    // is scherp schalen verspilde rekentijd.
    const i = opties.inhoud;
    // Met gemeten inhoud: alleen dat gebied als voorgrond, zo groot als in
    // 9:16 past. De geblurde achtergrond blijft het hele beeld.
    const b = opties.beweging;
    const beweegt = Boolean(i && b && b.duur >= instelling('GRAPHIC_BEWEGING_VANAF'));
    // Push-in op dubbele resolutie (anders trilt zoompan op hele pixels),
    // binnen de marge die inhoudKader rond de inhoud laat.
    const gericht = beweegt && i && b && opties.focus && opties.focus.length >= 2 ? gerichteZoom(i, opties.focus, b) : null;
    const push = gericht
      ? `,scale=${i!.fgB * 2}:${i!.fgH * 2}:flags=lanczos,${gericht}`
      : beweegt && i && b
        ? `,scale=${i.fgB * 2}:${i.fgH * 2}:flags=lanczos,zoompan=z='1+${instelling('GRAPHIC_BEWEGING').toFixed(3)}*min(1,(in/${b.fps}+${b.vanaf.toFixed(3)})/${b.duur.toFixed(3)})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${i.fgB}x${i.fgH}:fps=${b.fps}`
        : '';
    const voorgrond = i
      ? `crop=iw*${(i.r.x1 - i.r.x0).toFixed(4)}:ih*${(i.r.y1 - i.r.y0).toFixed(4)}:iw*${i.r.x0.toFixed(4)}:ih*${i.r.y0.toFixed(4)},scale=${i.fgB}:${i.fgH}:flags=lanczos${push}`
      : 'scale=1080:-2:flags=lanczos';
    // De voorgrond op de hoogte die inhoudKader koos (de inhoud tussen de
    // kaarten en de ondertitels); zonder gemeten inhoud gecentreerd.
    const y = i ? String(i.y0) : '(H-h)/2';
    return `split[a][b];[a]scale=192:342:force_original_aspect_ratio=increase,crop=192:342,boxblur=6:2,scale=1080:1920[bg];[b]${voorgrond}[fg];[bg][fg]overlay=(W-w)/2:${y},format=yuv420p`;
  }

  // vullend: hoogte vullen (maal de zoom voor punch-ins), dan de uitsnede op
  // het focuspunt leggen. De klem in de x-expressie voorkomt dat de uitsnede
  // buiten beeld schuift bij focus hard links of rechts.
  const hoogte = Math.round((1920 * zoom) / 2) * 2;
  // Verticaal: standaard het midden, maar met een focusY leggen we de ogen op
  // ongeveer een derde van boven. Een sprekend hoofd hoort daar; precies
  // gecentreerd geeft te veel lucht boven en een kin tegen de onderrand.
  const fy = opties.focusYExpr ?? Math.min(1, Math.max(0, opties.focusY ?? 0.5)).toFixed(3);
  // Een 9:16-uitsnede uit een 1080p-bron is ~608x1080 en wordt bijna 1,8x
  // opgeschaald; met de standaard bicubic-scaler oogt een gezicht dan wazig.
  // Lanczos houdt meer detail vast, en alleen bij echt opschalen komt er een
  // milde verscherping achteraan (op een neergeschaalde 1440p-bron niet).
  const factor = opschaalFactor(zoom, opties.bronHoogte);
  const scherp = factor > instelling('OPSCHAAL_VERSCHERP_VANAF') ? ',unsharp=5:5:0.5:5:5:0.0' : '';
  return (
    `scale=-2:${hoogte}:flags=lanczos,` +
    // Horizontaal net als verticaal: het focuspunt is het middelpunt van de
    // uitsnede. Zo betekent focusX overal hetzelfde — in de meting, in de
    // controle en hier in de render.
    `crop=1080:1920:min(max(iw*${f}-540\\,0)\\,iw-1080):min(max(ih*${fy}-960\\,0)\\,ih-1920)${scherp},` +
    'format=yuv420p'
  );
}

/**
 * zoompan die de spreker volgt: eerst de hele graphic, en op het moment dat
 * een blok genoemd wordt een vloeiende overgang (0,35 s) naar dat blok, zo
 * ver ingezoomd dat het blok heel in beeld blijft (hoogstens
 * GRAPHIC_FOCUS_ZOOM). Tijd T loopt vanaf het begin van wat er van dit deel
 * in beeld staat (b.vanaf voor het vastgehouden frame).
 */
export function gerichteZoom(
  i: { r: { x0: number; y0: number; x1: number; y1: number }; fgB: number; fgH: number },
  focus: { t: number; cx: number; cy: number; b: number; h: number }[],
  b: { vanaf: number; fps: number },
): string {
  const rb = i.r.x1 - i.r.x0;
  const rh = i.r.y1 - i.r.y0;
  const overgang = 0.35;
  type Sleutel = { t: number; fx: number; fy: number; z: number };
  const sleutels: Sleutel[] = [{ t: 0, fx: 0.5, fy: 0.5, z: 1 }];
  for (const p of focus) {
    const fx = Math.min(1, Math.max(0, (p.cx - i.r.x0) / rb));
    const fy = Math.min(1, Math.max(0, (p.cy - i.r.y0) / rh));
    const deel = Math.max(p.b / rb, p.h / rh, 0.05);
    const z = Math.max(1, Math.min(instelling('GRAPHIC_FOCUS_ZOOM'), 0.85 / deel));
    const vorige = sleutels[sleutels.length - 1];
    const t = Math.max(p.t, vorige.t + overgang + 0.05);
    sleutels.push({ ...vorige, t: t - overgang });
    sleutels.push({ t, fx, fy, z });
  }
  const T = `(in/${b.fps}+${b.vanaf.toFixed(3)})`;
  // Stuksgewijs lineair: na de laatste sleutel blijft de waarde staan.
  const lijn = (v: (s: Sleutel) => number): string => {
    let expr = v(sleutels[sleutels.length - 1]).toFixed(4);
    for (let k = sleutels.length - 2; k >= 0; k--) {
      const a = sleutels[k];
      const c = sleutels[k + 1];
      const duur = Math.max(0.001, c.t - a.t);
      expr = `if(lt(${T},${c.t.toFixed(3)}),${v(a).toFixed(4)}+(${(v(c) - v(a)).toFixed(4)})*(${T}-${a.t.toFixed(3)})/${duur.toFixed(3)},${expr})`;
    }
    return expr;
  };
  const z = lijn((s) => s.z);
  const fx = lijn((s) => s.fx);
  const fy = lijn((s) => s.fy);
  return (
    `zoompan=z='${z}':x='max(0,min(iw-iw/zoom,(${fx})*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,(${fy})*ih-ih/zoom/2))'` +
    `:d=1:s=${i.fgB}x${i.fgH}:fps=${b.fps}`
  );
}

/** Hoeveel een vullende uitsnede opgeschaald wordt: doelhoogte (1920 maal de zoom) gedeeld door de bronhoogte. */
export function opschaalFactor(zoom = 1, bronHoogte = 1080): number {
  return (1920 * zoom) / Math.max(1, bronHoogte);
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
 * Zoom-ingrepen (punch_in, snelle_zoom) zijn echte beweging: een zoompan die
 * in een fractie van een seconde inzoomt en dan vasthoudt. Eerder waren het
 * vaste schaalfactoren — een "snelle zoom" zag er dan uit als een kaderwissel
 * op de knip, nooit als zoom. De zoompan werkt op het al gekadreerde
 * 1080x1920-beeld en zoomt op het midden, waar het gezicht na de
 * kadercontrole staat.
 */
export const BEELD_EFFECTEN_BEKEND = ['punch_in', 'snelle_zoom', 'shake', 'freeze_frame', 'flits_wit', 'zwart_frame', 'tekstkaart', 'hit'] as const;

export function effectKeten(
  effect?: string | null,
  duur = 0,
  opties: {
    fps?: string | number;
    staand?: boolean;
    /** Zachte in- en uitloop (smoothstep) in plaats van lineair; standaard aan. */
    easing?: boolean;
    /** hit: seconde binnen het shot waarop de hit valt. */
    vanaf?: number;
    /** wissel: van welke naar welke relatieve schaal (≥ 1). */
    van?: number;
    naar?: number;
  } = {},
): string | null {
  if (!effect || effect === 'geen') return null;
  const fps = Number(opties.fps ?? 30) || 30;
  const zacht = opties.easing !== false;
  // Voortgang p (0..1) als ffmpeg-expressie: lineair, of smoothstep
  // (p²·(3−2p)) — een zoom die zachtjes vertrekt en zachtjes landt leest als
  // camerawerk, een lineaire als een effect.
  const voortgang = (frames: string) =>
    zacht ? `(st(0,min(1,max(0,${frames})))*ld(0)*(3-2*ld(0)))` : `min(1,max(0,${frames}))`;
  const zoompan = (z: string) =>
    `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=${fps}`;

  if ((effect === 'punch_in' || effect === 'snelle_zoom') && opties.staand !== false) {
    const schaal = effect === 'punch_in' ? instelling('PUNCH_IN_SCHAAL') : instelling('SNELLE_ZOOM_SCHAAL');
    const aanloop = effect === 'punch_in' ? instelling('PUNCH_IN_DUUR') : instelling('SNELLE_ZOOM_DUUR');
    const extra = (schaal - 1).toFixed(3);
    const frames = Math.max(1, aanloop * fps).toFixed(2);
    // zoompan kent geen t, wel het invoerframenummer `in`; met d=1 en dezelfde
    // fps als de stroom is in/fps de tijd binnen het shot.
    return zoompan(`1+${extra}*${voortgang(`in/${frames}`)}`);
  }

  if (effect === 'hit' && opties.staand !== false) {
    // Een korte "hit" op het payoff-woord: in 80 ms naar 1,08 en in 300 ms
    // terug. Voelbaar als klap, niet als zoom.
    const extra = (instelling('HIT_SCHAAL') - 1).toFixed(3);
    const start = Math.max(0, (opties.vanaf ?? 0) * fps).toFixed(2);
    const fIn = Math.max(1, instelling('HIT_IN') * fps).toFixed(2);
    const fUit = Math.max(1, instelling('HIT_UIT') * fps).toFixed(2);
    const op = voortgang(`(in-${start})/${fIn}`);
    const af = voortgang(`(in-${start}-${fIn})/${fUit}`);
    return zoompan(`1+${extra}*if(lt(in,${start}),0,if(lt(in-${start},${fIn}),${op},1-${af}))`);
  }

  if (effect === 'wissel' && opties.staand !== false) {
    // Een retentie-kaderwissel als korte push: van het vorige kader naar het
    // nieuwe in RETENTIE_WISSEL_DUUR, in plaats van een harde sprong.
    const van = Math.max(1, opties.van ?? 1);
    const naar = Math.max(1, opties.naar ?? 1);
    const frames = Math.max(1, instelling('RETENTIE_WISSEL_DUUR') * fps).toFixed(2);
    return zoompan(`${van.toFixed(4)}+(${(naar - van).toFixed(4)})*${voortgang(`in/${frames}`)}`);
  }

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
  // Gladstrijken met een zwaartepunt op het punt zelf (1-2-1). Een plat
  // gemiddelde over drie punten haalt de ruis er wel uit maar trekt het spoor
  // ook merkbaar van de werkelijke positie af — en gecentreerd staan is de eis.
  const glad = gevuld.map((m, i) => {
    const vorige = gevuld[i - 1] ?? m;
    const volgende = gevuld[i + 1] ?? m;
    return { t: m.t, x: (vorige.x + 2 * m.x + volgende.x) / 4 };
  });

  // Het spoor volgt de meting zelf, zonder demping.
  //
  // Demping klinkt als een goed idee — een camera die zachtjes bijtrekt — maar
  // hij loopt per definitie achter, en dat is meetbaar fout gegaan: het gezicht
  // stond in de bron op 0,52 terwijl het kader nog op 0,67 stuurde, en dan
  // staat de spreker een derde uit het midden. In het midden staan weegt
  // zwaarder dan een zachte camerabeweging, en het gladstrijken hierboven maakt
  // de beweging al vloeiend genoeg.
  //
  // Wat blijft is een snelheidsplafond, maar ruim: alleen om een sprong die
  // door de filters heen glipt niet als schok in beeld te zetten.
  const maxPerStap = maxSnelheid * 4;
  const uit: { t: number; x: number }[] = [];
  let positie = glad[0].x;
  for (const [i, punt] of glad.entries()) {
    const dt = i === 0 ? 0 : punt.t - glad[i - 1].t;
    const plafond = Math.max(0.05, maxPerStap * Math.max(dt, 0.001));
    positie = i === 0 ? punt.x : positie + Math.max(-plafond, Math.min(plafond, punt.x - positie));
    uit.push({ t: punt.t, x: Math.min(1, Math.max(0, positie)) });
  }

  return uit;
}
