import { spawn, spawnSync } from 'node:child_process';
import { resolveBinary } from '../ingest/binaries';
import type { Shot } from './index';
import { instelling } from './instellingen';
import type { Kader } from './kader';
import type { KeuringRegel } from './keuring';
import { deelstukken } from './scenes';
import { leestijdPlan } from './leestijd';
import type { BronWoord } from './woorden';

/**
 * De eindkeuring: wat een kijker ziet en hoort, gemeten op het gerenderde
 * bestand zelf.
 *
 * De regel "actieve spreker in beeld" in keuring.ts rekent met de kadervelden
 * van het plan — dezelfde velden die de herstelstappen zetten. Een herstel
 * keurde daardoor zichzelf goed, en een kader op een speakerkast kreeg GOED
 * omdat de meting op dat moment "geen gezicht" gaf en dat moment dan
 * oversloeg. Deze regels lezen het plan alleen om te weten waar een graphic
 * staat (daar hoort geen mens in beeld te zijn); het oordeel komt uit de mp4.
 *
 * Alle regels hier zijn verplicht: kan er niet gemeten worden, dan is de
 * uitslag "review nodig", niet "goed".
 */

const verplicht = (r: Omit<KeuringRegel, 'verplicht'>): KeuringRegel => ({ ...r, verplicht: true });

function ffmpegStderr(args: string[]): Promise<string | null> {
  return new Promise((klaar) => {
    const kind = spawn(resolveBinary('ffmpeg'), ['-hide_banner', '-nostats', ...args, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let uit = '';
    kind.stderr.on('data', (d) => (uit += d));
    kind.on('error', () => klaar(null));
    kind.on('close', (code) => klaar(code === 0 ? uit : null));
  });
}

// ------------------------------------------------------------------ geluid

export type GeluidMeting = { lufs: number; piek: number };

/** Geïntegreerde luidheid en hoogste piek van het eindbestand (EBU R128). */
export async function meetGeluid(montagePad: string): Promise<GeluidMeting | null> {
  const uit = await ffmpegStderr(['-i', montagePad, '-vn', '-af', 'ebur128=peak=true']);
  if (!uit) return null;
  const samenvatting = uit.slice(uit.lastIndexOf('Summary:'));
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(samenvatting)?.[1]);
  const piek = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(samenvatting)?.[1]);
  return Number.isFinite(lufs) && Number.isFinite(piek) ? { lufs, piek } : null;
}

export function keurGeluid(m: GeluidMeting | null): KeuringRegel {
  const naam = 'geluid op niveau';
  if (!m) return verplicht({ naam, goed: null, detail: 'luidheid niet te meten' });
  const [min, max, piekMax] = [instelling('EINDKEURING_LUFS_MIN'), instelling('EINDKEURING_LUFS_MAX'), instelling('EINDKEURING_PIEK_MAX')];
  const fouten: string[] = [];
  if (m.lufs < min) fouten.push(`te zacht (${m.lufs.toFixed(1)} LUFS, hoort tussen ${min} en ${max})`);
  if (m.lufs > max) fouten.push(`te hard (${m.lufs.toFixed(1)} LUFS, hoort tussen ${min} en ${max})`);
  if (m.piek > piekMax) fouten.push(`pieken tot ${m.piek.toFixed(1)} dBFS (vervormt; hoort onder ${piekMax})`);
  return verplicht({ naam, goed: fouten.length === 0, detail: fouten.length ? fouten.join('; ') : `${m.lufs.toFixed(1)} LUFS, piek ${m.piek.toFixed(1)} dBFS` });
}

// ------------------------------------------------------------------- zwart

/** Stukken zwart beeld in het eindbestand, als [van, tot] in seconden. */
export async function meetZwart(montagePad: string): Promise<[number, number][] | null> {
  const uit = await ffmpegStderr(['-i', montagePad, '-an', '-vf', `blackdetect=d=${instelling('EINDKEURING_ZWART_MIN_S')}:pix_th=0.10`]);
  if (uit === null) return null;
  return [...uit.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

export function keurZwart(stukken: [number, number][] | null): KeuringRegel {
  const naam = 'geen zwart beeld';
  if (!stukken) return verplicht({ naam, goed: null, detail: 'beeld niet te meten' });
  return verplicht({
    naam,
    goed: stukken.length === 0,
    detail: stukken.length === 0 ? 'nergens zwart' : stukken.map(([a, b]) => `zwart van ${a.toFixed(1)} tot ${b.toFixed(1)} s`).join('; '),
  });
}

// --------------------------------------------------------- mens in beeld

/**
 * Per meetmoment: staat er een gezicht in het eindbeeld? true/false, of
 * 'links'/'rechts' als het grootste gezicht die beeldrand raakt (afgesneden
 * hoofd). null = meting van dat moment mislukt.
 */
export type BeeldUitslag = boolean | 'links' | 'rechts' | null;
export type BeeldMeter = (tijden: number[]) => Promise<BeeldUitslag[] | null>;

/** De standaardmeter: scripts/eindbeeld.py op het eindbestand (verkleind, zie daar waarom). */
export function beeldMeterVia(montagePad: string, py: { cmd: string; voor: string[] }): BeeldMeter {
  return async (tijden) => {
    const res = spawnSync(py.cmd, [...py.voor, 'scripts/eindbeeld.py', montagePad, JSON.stringify(tijden)], { encoding: 'utf8', maxBuffer: 20_000_000 });
    try {
      // OpenCV schrijft soms zelf naar stdout; pak de laatste regel die JSON is.
      const regel = (res.stdout ?? '').split('\n').map((r) => r.trim()).reverse().find((r) => r.startsWith('['));
      const m = JSON.parse(regel || '[]') as BeeldUitslag[];
      return m.length === tijden.length ? m : null;
    } catch {
      return null;
    }
  };
}

/**
 * Waar op de tijdlijn hoort géén mens in beeld te zijn: de deelstukken die de
 * render als graphic (passend, met vervaagde vulling) toont. Met wat marge,
 * want een overgang is geen harde grens.
 */
export function tijdlijnZonderMens(segmenten: Shot[], kader: Kader): [number, number][] {
  const uit: [number, number][] = [];
  // Een graphic blijft langer staan dan zijn stuk bron als hij leestijd
  // nodig heeft (leestijd.ts, "vasthouden"). Precies daar zocht de keuring
  // eerst een mens: platina, niemand in beeld van 6,8 tot 8,0 s — de graphic
  // stond er nog. Hier dus wat de render werkelijk toont.
  try {
    for (const g of leestijdPlan(segmenten, kader).graphics) uit.push([g.beeldStart - 0.3, g.beeldStart + g.getoond + 0.3]);
  } catch {
    // zonder leesplan alleen de deelstukken hieronder
  }
  let c = 0;
  for (const seg of [...segmenten].sort((a, b) => a.volgorde - b.volgorde)) {
    for (const d of deelstukken(seg, kader)) {
      if (d.gezicht === false || d.kader === 'blur' || d.kader === 'origineel') uit.push([c + d.van - 0.3, c + d.tot + 0.3]);
    }
    c += seg.end - seg.start;
  }
  return uit;
}

/**
 * Regel: er staat een mens in beeld, behalve waar een graphic hoort te staan.
 * Een leeg kader (muur, speakerkast, een hand) is de fout die deze regel vangt.
 */
export async function keurMensInBeeld(duur: number, meter: BeeldMeter, zonderMens: [number, number][] = []): Promise<KeuringRegel> {
  const naam = 'mens in beeld (eindbestand)';
  const stap = 1 / instelling('EINDKEURING_FPS');
  const tijden = eindbeeldTijden(duur, zonderMens);
  if (tijden.length === 0) {
    return verplicht({ naam, goed: true, detail: 'de hele clip is graphic; geen mens verwacht' });
  }
  const m = await meter(tijden);
  if (!m) return verplicht({ naam, goed: null, detail: 'gezichtsmeting op het eindbestand mislukt' });
  const gemeten = m.filter((x) => x !== null).length;
  const leeg = tijden.filter((_, i) => m[i] === false);
  if (gemeten === 0) return verplicht({ naam, goed: null, detail: 'geen enkel moment te meten' });
  if (leeg.length === gemeten) {
    // Een bron zonder mensen (landschap, gameplay, animatie) of een kader dat
    // overal mist: de meting kan dat verschil niet zien. Een mens moet kijken.
    return verplicht({ naam, goed: null, detail: `op geen van de ${gemeten} momenten een gezicht gevonden — bron zonder mensen, of het kader mist overal; bekijk de clip` });
  }

  // Aaneengesloten lege stukken: opeenvolgende meetmomenten zonder gezicht.
  const gaten: [number, number][] = [];
  for (let i = 0; i < tijden.length; i++) {
    if (m[i] !== false) continue;
    const vorige = gaten[gaten.length - 1];
    if (vorige && i > 0 && m[i - 1] === false && tijden[i] - tijden[i - 1] <= stap * 1.5) vorige[1] = tijden[i];
    else gaten.push([tijden[i], tijden[i]]);
  }
  const maxLeeg = instelling('EINDKEURING_LEEG_MAX_S');
  const lang = gaten.filter(([a, b]) => b - a + stap >= maxLeeg);
  const aandeel = leeg.length / gemeten;
  const fouten = lang.map(([a, b]) => `niemand in beeld van ${(a - stap / 2).toFixed(1)} tot ${(b + stap / 2).toFixed(1)} s`);
  if (aandeel > instelling('EINDKEURING_LEEG_MAX_AANDEEL')) fouten.push(`op ${Math.round(aandeel * 100)}% van de momenten niemand in beeld`);
  return verplicht({
    naam,
    goed: fouten.length === 0,
    detail: fouten.length ? fouten.join('; ') : `${gemeten} momenten bekeken, ${leeg.length} zonder gezicht (los, korter dan ${maxLeeg} s)`,
  });
}

/** De meetmomenten van de eindkeuring: EINDKEURING_FPS keer per seconde, buiten de graphics. */
export function eindbeeldTijden(duur: number, zonderMens: [number, number][] = []): number[] {
  const stap = 1 / instelling('EINDKEURING_FPS');
  const tijden: number[] = [];
  for (let t = stap / 2; t < duur - 0.1; t += stap) {
    if (!zonderMens.some(([a, b]) => t >= a && t <= b)) tijden.push(Math.round(t * 100) / 100);
  }
  return tijden;
}

/** Momenten waarop het hoofd tegen de beeldrand staat: [tijd, kant]. */
export function randMomenten(tijden: number[], m: BeeldUitslag[]): { t: number; kant: 'links' | 'rechts' }[] {
  return tijden.flatMap((t, i) => (m[i] === 'links' || m[i] === 'rechts' ? [{ t, kant: m[i] as 'links' | 'rechts' }] : []));
}

/**
 * Regel: het hoofd staat heel in beeld. Een gezicht dat de linker- of
 * rechterrand raakt is afgesneden — de regel "mens in beeld" ziet dat niet
 * (er ís een gezicht), en de planmeting miste het in de Koen-clip.
 */
export async function keurHoofdHeel(duur: number, meter: BeeldMeter, zonderMens: [number, number][] = []): Promise<KeuringRegel> {
  const naam = 'hoofd heel in beeld (eindbestand)';
  const tijden = eindbeeldTijden(duur, zonderMens);
  if (tijden.length === 0) return verplicht({ naam, goed: true, detail: 'de hele clip is graphic' });
  const m = await meter(tijden);
  if (!m) return verplicht({ naam, goed: null, detail: 'gezichtsmeting op het eindbestand mislukt' });
  const rand = randMomenten(tijden, m);
  const stap = 1 / instelling('EINDKEURING_FPS');
  let langste = 0;
  let reeks = 0;
  let vanaf = 0;
  let langsteVanaf = 0;
  for (let i = 0; i < tijden.length; i++) {
    if (m[i] === 'links' || m[i] === 'rechts') {
      if (reeks === 0) vanaf = tijden[i];
      reeks++;
      if (reeks > langste) {
        langste = reeks;
        langsteVanaf = vanaf;
      }
    } else reeks = 0;
  }
  const aandeel = rand.length / tijden.length;
  const fouten: string[] = [];
  if (langste * stap >= instelling('EINDKEURING_RAND_MAX_S')) fouten.push(`hoofd ${(langste * stap).toFixed(1)} s tegen de ${rand.find((r) => r.t >= langsteVanaf)?.kant === 'links' ? 'linker' : 'rechter'}rand vanaf ${langsteVanaf.toFixed(1)} s`);
  if (aandeel > instelling('EINDKEURING_RAND_MAX_AANDEEL')) fouten.push(`op ${Math.round(aandeel * 100)}% van de momenten raakt het hoofd de rand`);
  return verplicht({ naam, goed: fouten.length === 0, detail: fouten.length ? fouten.join('; ') : `${tijden.length} momenten bekeken, ${rand.length} tegen de rand` });
}

// ------------------------------------------------------------ hook en einde

const inVolgorde = (segmenten: Shot[]) => [...segmenten].sort((a, b) => a.volgorde - b.volgorde);

/** Regel: de clip begint met spraak. Een halve seconde stilte of adem vooraf kost de kijker. */
export function keurHook(segmenten: Shot[], bronWoorden: BronWoord[] | null): KeuringRegel {
  const naam = 'opent met spraak';
  const eerste = inVolgorde(segmenten)[0];
  if (!eerste || !bronWoorden?.length) return verplicht({ naam, goed: null, detail: 'geen brontranscriptie; niet te toetsen' });
  const woord = bronWoorden.find((w) => w.e > eerste.start + 0.02 && w.s < eerste.end);
  const max = instelling('EINDKEURING_HOOK_MAX_S');
  if (!woord) return verplicht({ naam, goed: false, detail: 'in het eerste shot wordt niet gesproken' });
  const wacht = Math.max(0, woord.s - eerste.start);
  return verplicht({
    naam,
    goed: wacht <= max,
    detail: wacht <= max ? `eerste woord ("${woord.w}") na ${wacht.toFixed(2)} s` : `eerste woord ("${woord.w}") pas na ${wacht.toFixed(2)} s (hoort binnen ${max} s)`,
  });
}

/** Regel: de clip stopt kort na het laatste woord. Seconden zonder tekst aan het einde is na-ijlen. */
export function keurStaart(segmenten: Shot[], bronWoorden: BronWoord[] | null): KeuringRegel {
  const naam = 'stopt na het laatste woord';
  const volg = inVolgorde(segmenten);
  const laatste = volg[volg.length - 1];
  if (!laatste || !bronWoorden?.length) return verplicht({ naam, goed: null, detail: 'geen brontranscriptie; niet te toetsen' });
  // Terugtellen over aansluitende stukken: het laatste stuk mag een woordloze
  // reactie zijn, als het geheel maar niet te lang zonder woorden uitloopt.
  let stil = 0;
  for (let i = volg.length - 1; i >= 0; i--) {
    const sg = volg[i];
    const woorden = bronWoorden.filter((w) => w.s < sg.end - 0.02 && w.e > sg.start + 0.02);
    if (woorden.length) {
      stil += Math.max(0, sg.end - Math.min(sg.end, woorden[woorden.length - 1].e));
      break;
    }
    stil += sg.end - sg.start;
  }
  const max = instelling('EINDKEURING_STAART_MAX_S');
  return verplicht({
    naam,
    goed: stil <= max,
    detail: stil <= max ? `${stil.toFixed(1)} s na het laatste woord` : `${stil.toFixed(1)} s zonder woorden aan het einde (hoort onder ${max} s)`,
  });
}

/** Regel: er wordt gesproken, dus er horen ondertitels te staan (tenzij de campagne ze uitzet). */
export function keurOndertitelsAanwezig(aantalRegels: number | null, verwacht: boolean): KeuringRegel {
  const naam = 'ondertitels aanwezig';
  if (!verwacht) return { naam, goed: true, detail: 'uitgezet voor deze campagne' };
  if (aantalRegels === null) return verplicht({ naam, goed: false, detail: 'geen ondertitels gemaakt (transcriptie of opmaak mislukt)' });
  return verplicht({ naam, goed: aantalRegels > 0, detail: aantalRegels > 0 ? `${aantalRegels} regels` : 'geen enkele regel' });
}

/** De eindkeuring in één keer: alle metingen op het bestand, plus hook, einde en ondertitels. */
export async function keurEindbestand(
  montagePad: string,
  segmenten: Shot[],
  bronWoorden: BronWoord[] | null,
  opties: {
    duur: number;
    kader: Kader;
    python?: { cmd: string; voor: string[] };
    beeldMeter?: BeeldMeter;
    ondertitelRegels: number | null;
    ondertitelsVerwacht: boolean;
  },
): Promise<KeuringRegel[]> {
  // Eén meting voor beide beeldregels (zelfde momenten).
  const ruw = opties.beeldMeter ?? beeldMeterVia(montagePad, opties.python ?? { cmd: 'python3', voor: [] });
  const onthouden = new Map<string, Promise<BeeldUitslag[] | null>>();
  const meter: BeeldMeter = (tijden) => {
    const sleutel = tijden.join(',');
    if (!onthouden.has(sleutel)) onthouden.set(sleutel, ruw(tijden));
    return onthouden.get(sleutel)!;
  };
  const zonderMens = tijdlijnZonderMens(segmenten, opties.kader);
  const [geluid, zwart, mens, hoofd] = await Promise.all([
    meetGeluid(montagePad).then(keurGeluid),
    meetZwart(montagePad).then(keurZwart),
    keurMensInBeeld(opties.duur, meter, zonderMens),
    keurHoofdHeel(opties.duur, meter, zonderMens),
  ]);
  return [
    mens,
    hoofd,
    zwart,
    geluid,
    keurHook(segmenten, bronWoorden),
    keurStaart(segmenten, bronWoorden),
    keurOndertitelsAanwezig(opties.ondertitelRegels, opties.ondertitelsVerwacht),
  ];
}
