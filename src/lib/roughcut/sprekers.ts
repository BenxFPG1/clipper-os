import { spawn } from 'node:child_process';
import { resolveBinary } from '../ingest/binaries';
import { instelling } from './instellingen';
import type { Shot } from './index';
import type { BronWoord } from './woorden';

/**
 * Actieve-sprekerdetectie: wie praat er, in welk camerastandpunt?
 *
 * Bij één persoon in beeld is "het gezicht" de spreker. Aan een tafel met
 * drie of vier mensen niet: de detectie pakte per meetpunt wie toevallig het
 * meest bewoog, het spoor sprong tussen personen (0,33 ↔ 0,81) en het kader
 * stond op een lege muur, een hand of een spreker op de rand. Daarbij knipt
 * zo'n bron zelf tussen camera's: wie op x=0,4 zit is na de knip iemand
 * anders.
 *
 * Aanpak:
 *  1. gezichten.py --sprekers meet per bereik elke 0,1 s alle gezichten, de
 *     mondbeweging per gezicht (mond min ogen: knikken telt niet) en de
 *     bronknippen op het frame. Na een knip beginnen de sporen opnieuw.
 *  2. Per venster van ~0,5 s (met wat context) krijgt elk gezicht een score:
 *     hoe sterk zijn mondbeweging meegaat met de spraakenergie, relatief aan
 *     zijn eigen rustniveau (kauwen zonder geluid telt zo nauwelijks).
 *  3. De hoogste score is de spreker, met hysterese: niet wisselen binnen
 *     SPREKER_MIN_VAST seconden, tenzij de bron knipt.
 *  4. Het kader volgt: een bronknip wordt een knip in de montage (elk
 *     standpunt zijn eigen kader op zijn eigen spreker); een sprekerwissel
 *     binnen één standpunt wordt een harde kaderwissel op een woordgrens, of
 *     — zonder woordgrens in de buurt — een snelle pan. Twee mensen dicht
 *     naast elkaar die om beurten praten: een tweeshot.
 */

export type SprekerMonster = [t: number, x: number, mond: number | null];
export type SprekerPersoon = {
  id: number;
  scene: number;
  x: number;
  breedte: number;
  oog: number;
  top: number;
  hoogte: number;
  n: number;
  monsters: SprekerMonster[];
};
export type SprekerMeting = { van: number; tot: number; stap: number; personen: SprekerPersoon[]; knippen: number[] };

/** Eén stuk tijdlijn met één actieve spreker (of een tweeshot). */
export type SprekerStuk = {
  van: number;
  tot: number;
  scene: number;
  persoon: SprekerPersoon | null;
  /** Tweeshot: twee personen dicht bij elkaar die om beurten praten. */
  tweeshot?: [SprekerPersoon, SprekerPersoon];
  /** Begint dit stuk op een bronknip (camerawissel)? */
  opKnip: boolean;
};

/** Spraakenergie per stap (0..1, genormaliseerd op het 90e percentiel) uit het geluid van de bron. */
export async function spraakEnergie(bron: string, van: number, tot: number, stap = 0.1): Promise<number[]> {
  const sr = 8000;
  const buf = await new Promise<Buffer>((klaar, fout) => {
    const kind = spawn(
      resolveBinary('ffmpeg'),
      ['-nostdin', '-v', 'error', '-ss', van.toFixed(3), '-t', (tot - van).toFixed(3), '-i', bron, '-vn', '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const delen: Buffer[] = [];
    kind.stdout.on('data', (d: Buffer) => delen.push(d));
    kind.on('error', fout);
    kind.on('close', (code) => (code === 0 ? klaar(Buffer.concat(delen)) : fout(new Error(`ffmpeg spraakenergie exit ${code}`))));
  });
  const perStap = Math.round(sr * stap);
  const n = Math.floor(buf.length / 2 / perStap);
  const rms: number[] = [];
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = 0; j < perStap; j++) {
      const v = buf.readInt16LE((i * perStap + j) * 2) / 32768;
      e += v * v;
    }
    rms.push(Math.sqrt(e / perStap));
  }
  const gesorteerd = [...rms].sort((a, b) => a - b);
  const p90 = gesorteerd[Math.floor(gesorteerd.length * 0.9)] || 1e-6;
  const p20 = gesorteerd[Math.floor(gesorteerd.length * 0.2)] ?? 0;
  // Onder de ruisvloer (20e percentiel) telt als stilte.
  return rms.map((r) => Math.max(0, Math.min(1, (r - p20) / Math.max(1e-6, p90 - p20))));
}

const mediaan = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 4) return 0;
  const ma = a.reduce((t, x) => t + x, 0) / n;
  const mb = b.reduce((t, x) => t + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 1e-9 && sbb > 1e-9 ? sab / Math.sqrt(saa * sbb) : 0;
}

/**
 * De tijdlijn van actieve sprekers voor één meting. `spraak[i]` hoort bij
 * tijd van + i·stap. Woorden (optioneel) vullen de spraakenergie aan waar het
 * geluid (muziek onder de spraak) weinig zegt.
 */
export function actieveSprekers(meting: SprekerMeting, spraak: number[], opties: { woorden?: BronWoord[] | null } = {}): SprekerStuk[] {
  const { van, tot, stap } = meting;
  const venster = instelling('SPREKER_VENSTER');
  const minVast = instelling('SPREKER_MIN_VAST');
  const grenzen = [van, ...meting.knippen.filter((k) => k > van && k < tot), tot];
  const woorden = opties.woorden ?? [];
  const actief = (t: number) => {
    const i = Math.round((t - van) / stap);
    const a = spraak[Math.max(0, Math.min(spraak.length - 1, i))] ?? 0;
    const w = woorden.some((x) => x.s <= t && x.e >= t) ? 0.6 : 0;
    return Math.max(a, w);
  };
  const stukken: SprekerStuk[] = [];
  for (let s = 0; s + 1 < grenzen.length; s++) {
    const a = grenzen[s];
    const b = grenzen[s + 1];
    const personen = voegDubbeleSamen(meting.personen.filter((p) => p.scene === s));
    const opKnip = s > 0;
    if (personen.length === 0) {
      stukken.push({ van: a, tot: b, scene: s, persoon: null, opKnip });
      continue;
    }
    if (personen.length === 1) {
      stukken.push({ van: a, tot: b, scene: s, persoon: personen[0], opKnip });
      continue;
    }
    // Eén gedeeld rustniveau voor het standpunt (25e percentiel van alle
    // monden): per persoon normaliseren zou de spreker, die bijna steeds
    // praat, juist wegdrukken tot zijn eigen gemiddelde.
    const alleMond = personen.flatMap((p) => p.monsters.map((m) => m[2]).filter((x): x is number => x !== null)).sort((x, y) => x - y);
    const gedeeld = Math.max(0.5, alleMond[Math.floor(alleMond.length * 0.25)] ?? 0.5);
    const rust = new Map(personen.map((p) => [p.id, gedeeld]));
    const score = (p: SprekerPersoon, m0: number, m1: number) => {
      const ms = p.monsters.filter((m) => m[0] >= m0 && m[0] <= m1 && m[2] !== null);
      if (ms.length < 2) return -1;
      const mond = ms.map((m) => (m[2] as number) / rust.get(p.id)!);
      const sp = ms.map((m) => actief(m[0]));
      const gewogen = mond.reduce((t, x, i) => t + x * sp[i], 0) / ms.length;
      return gewogen + 0.5 * Math.max(0, pearson(mond, sp));
    };
    const keuzes: { t: number; p: SprekerPersoon }[] = [];
    let huidig: SprekerPersoon | null = null;
    let sinds = a;
    for (let t = a; t < b - 1e-6; t += venster) {
      const m0 = t - venster;
      const m1 = t + 2 * venster;
      const spraakHier = (() => {
        let som = 0;
        let n = 0;
        for (let u = t; u < Math.min(b, t + venster); u += stap) {
          som += actief(u);
          n++;
        }
        return n ? som / n : 0;
      })();
      const scores = personen.map((p) => ({ p, s: score(p, m0, m1) })).sort((x, y) => y.s - x.s);
      const beste = scores[0];
      if (!huidig) {
        huidig = beste.p;
        sinds = t;
      } else if (beste.p.id !== huidig.id && spraakHier > 0.15) {
        const hHuidig = scores.find((x) => x.p.id === huidig!.id)?.s ?? 0;
        if (t - sinds >= minVast && beste.s > hHuidig * 1.3 + 0.1) {
          huidig = beste.p;
          sinds = t;
        }
      }
      keuzes.push({ t, p: huidig });
    }
    // Aaneengesloten stukken per spreker.
    let begin = a;
    for (let k = 0; k < keuzes.length; k++) {
      const volgende = keuzes[k + 1];
      if (!volgende || volgende.p.id !== keuzes[k].p.id) {
        const eind = volgende ? volgende.t : b;
        stukken.push({ van: begin, tot: eind, scene: s, persoon: keuzes[k].p, opKnip: begin === a && opKnip });
        begin = eind;
      }
    }
    // Twee mensen dicht naast elkaar die elkaar steeds afwisselen: één
    // tweeshot in plaats van pingpong.
    const eigen = stukken.filter((x) => x.scene === s);
    const ids = new Set(eigen.map((x) => x.persoon?.id));
    if (eigen.length >= 3 && ids.size === 2) {
      const [p, q] = personen.filter((x) => ids.has(x.id));
      if (p && q && Math.abs(p.x - q.x) + Math.max(p.breedte, q.breedte) <= instelling('SPREKER_TWEESHOT_MAX')) {
        stukken.splice(stukken.length - eigen.length, eigen.length, { van: a, tot: b, scene: s, persoon: p, tweeshot: [p, q], opKnip });
      }
    }
  }
  return stukken;
}

/**
 * Twee sporen vlak naast elkaar in hetzelfde standpunt die elkaar in de tijd
 * nauwelijks overlappen zijn één persoon (de detector verloor hem even en
 * begon een nieuw spoor). Samenvoegen, anders "wisselt" de spreker naar
 * zichzelf.
 */
export function voegDubbeleSamen(personen: SprekerPersoon[]): SprekerPersoon[] {
  const uit: SprekerPersoon[] = [];
  for (const p of [...personen].sort((a, b) => b.n - a.n)) {
    const tijden = new Set(p.monsters.map((m) => m[0].toFixed(2)));
    const zelfde = uit.find((q) => {
      if (Math.abs(q.x - p.x) > 0.08) return false;
      const samen = q.monsters.filter((m) => tijden.has(m[0].toFixed(2))).length;
      return samen <= Math.min(q.n, p.n) * 0.2;
    });
    if (zelfde) {
      zelfde.monsters = [...zelfde.monsters, ...p.monsters].sort((a, b) => a[0] - b[0]);
      zelfde.n = zelfde.monsters.length;
    } else {
      uit.push({ ...p, monsters: [...p.monsters] });
    }
  }
  return uit.sort((a, b) => a.x - b.x);
}

/** Positie van een persoon op tijd t (lineair tussen zijn monsters). */
export function persoonX(p: SprekerPersoon, t: number): number {
  const ms = p.monsters;
  if (ms.length === 0) return p.x;
  if (t <= ms[0][0]) return ms[0][1];
  for (let i = 1; i < ms.length; i++) {
    if (ms[i][0] >= t) {
      const [t0, x0] = ms[i - 1];
      const [t1, x1] = ms[i];
      return t1 > t0 ? x0 + ((x1 - x0) * (t - t0)) / (t1 - t0) : x1;
    }
  }
  return ms[ms.length - 1][1];
}

/** Het gat tussen twee woorden dichtst bij t (binnen ±marge), of null. */
function woordgrensBij(woorden: BronWoord[], t: number, marge: number): number | null {
  let beste: number | null = null;
  for (let i = 0; i + 1 < woorden.length; i++) {
    const g = (woorden[i].e + woorden[i + 1].s) / 2;
    if (woorden[i + 1].s - woorden[i].e < 0.04) continue;
    if (Math.abs(g - t) <= marge && (beste === null || Math.abs(g - t) < Math.abs(beste - t))) beste = g;
  }
  return beste;
}

export type SprekerKader = {
  /** Aantal verschillende gezichten over het shot. */
  gezichten: number;
  /** Sprekerwissels binnen het shot (camerawissels meegeteld). */
  wissels: { t: number; soort: 'bronknip' | 'knip' | 'pan' | 'tweeshot' }[];
  /** Het shot is opgesplitst in deze delen (inclusief het origineel als eerste). */
  delen: Shot[];
};

/**
 * Past de sprekertijdlijn toe op één shot: focus, breedte en spoor op de
 * actieve spreker, en splitsen waar de spreker of het camerastandpunt
 * wisselt. Muteert `seg`; de extra delen komen in `delen` (na seg).
 */
export function pasSprekersToe(
  seg: Shot,
  stukkenAlle: SprekerStuk[],
  woorden: BronWoord[] | null,
  opties: { volgendeVolgorde?: number } = {},
): SprekerKader {
  const minDeel = instelling('SPREKER_MIN_DEEL');
  const stukken = stukkenAlle
    .filter((s) => s.tot > seg.start + 0.01 && s.van < seg.end - 0.01)
    .map((s) => ({ ...s, van: Math.max(seg.start, s.van), tot: Math.min(seg.end, s.tot) }));
  const gezichten = new Set(stukkenAlle.filter((s) => s.persoon).map((s) => `${s.scene}:${s.persoon!.id}`)).size;
  const wissels: SprekerKader['wissels'] = [];
  if (stukken.length === 0) return { gezichten, wissels, delen: [seg] };

  // Te korte stukken opgaan in hun buur (een flits van een ander standpunt
  // kan niet anders; een sprekerwissel van een halve seconde is ruis).
  for (let i = 0; i < stukken.length; i++) {
    // Een camerastandpunt mag kort zijn (een snelle reactie-shot); een
    // sprekerwissel binnen één standpunt niet.
    const grens = stukken[i].opKnip || stukken[i + 1]?.opKnip ? instelling('SPREKER_MIN_STANDPUNT') : minDeel;
    if (stukken.length > 1 && stukken[i].tot - stukken[i].van < grens) {
      const buur = i > 0 ? i - 1 : i + 1;
      stukken[buur].van = Math.min(stukken[buur].van, stukken[i].van);
      stukken[buur].tot = Math.max(stukken[buur].tot, stukken[i].tot);
      stukken.splice(i, 1);
      i = -1;
    }
  }

  // Grenzen: bronknip exact; sprekerwissel op een woordgrens, anders een pan.
  type Deel = { van: number; tot: number; stuk: SprekerStuk; pannen?: { t: number; naar: SprekerStuk }[] };
  const delen: Deel[] = [{ van: stukken[0].van, tot: stukken[0].tot, stuk: stukken[0] }];
  for (let i = 1; i < stukken.length; i++) {
    const s = stukken[i];
    const vorige = delen[delen.length - 1];
    if (s.opKnip && Math.abs(s.van - vorige.tot) < 0.02) {
      wissels.push({ t: s.van, soort: 'bronknip' });
      delen.push({ van: s.van, tot: s.tot, stuk: s });
      continue;
    }
    const grens = woorden?.length ? woordgrensBij(woorden, s.van, instelling('SPREKER_WOORDGRENS_MARGE')) : null;
    if (grens !== null && grens - vorige.van >= minDeel && s.tot - grens >= minDeel) {
      vorige.tot = grens;
      wissels.push({ t: grens, soort: 'knip' });
      delen.push({ van: grens, tot: s.tot, stuk: s });
    } else {
      // Geen woordgrens: in hetzelfde deel blijven en snel pannen.
      wissels.push({ t: s.van, soort: 'pan' });
      vorige.tot = s.tot;
      vorige.pannen = [...(vorige.pannen ?? []), { t: s.van, naar: s }];
    }
  }
  for (const d of delen) if (d.stuk.tweeshot) wissels.push({ t: d.van, soort: 'tweeshot' });

  const PAN = instelling('SPREKER_PAN_DUUR');
  const kader = (sh: Shot, d: Deel) => {
    const st = d.stuk;
    sh.spoor = undefined;
    sh.spoorY = undefined;
    sh.maxStap = undefined;
    if (!st.persoon) return;
    const pannen = d.pannen ?? [];
    sh.sprekerBepaald = true;
    sh.breed = false;
    if (st.tweeshot) {
      const [p, q] = st.tweeshot;
      sh.focusX = (p.x + q.x) / 2;
      sh.focusW = Math.abs(p.x - q.x) + Math.max(p.breedte, q.breedte);
      sh.focusWmin = sh.focusW;
      sh.spreiding = 0;
      sh.personen = 2;
      const links = Math.min(p.x - p.breedte / 2, q.x - q.breedte / 2);
      const rechts = Math.max(p.x + p.breedte / 2, q.x + q.breedte / 2);
      sh.gezicht = { x: (links + rechts) / 2, breedte: rechts - links, top: Math.min(p.top, q.top), hoogte: Math.max(p.top + p.hoogte, q.top + q.hoogte) - Math.min(p.top, q.top) };
      return;
    }
    sh.focusX = st.persoon.x;
    sh.focusW = st.persoon.breedte;
    sh.focusWmin = st.persoon.breedte;
    sh.personen = Math.max(1, gezichten);
    // Het hele gezichtsvak van déze persoon: daar rekenen verticale
    // kadrering en kadercontrole mee, niet met wie de oude meting koos.
    sh.gezicht = { x: st.persoon.x, breedte: st.persoon.breedte, top: st.persoon.top, hoogte: st.persoon.hoogte };
    // Spoor binnen dezelfde persoon (hij leunt, draait) plus eventuele snelle
    // pannen naar een volgende spreker. Nooit tussen personen door glijden.
    const punten: { t: number; x: number }[] = [];
    const volg = (p: SprekerPersoon, van: number, tot: number) => {
      for (const m of p.monsters) if (m[0] >= van && m[0] <= tot) punten.push({ t: m[0], x: m[1] });
    };
    let cursor = d.van;
    let wie = st.persoon;
    for (const pan of pannen) {
      volg(wie, cursor, pan.t - PAN / 2);
      punten.push({ t: pan.t - PAN / 2, x: persoonX(wie, pan.t - PAN / 2) });
      wie = pan.naar.persoon ?? wie;
      punten.push({ t: pan.t + PAN / 2, x: persoonX(wie, pan.t + PAN / 2) });
      cursor = pan.t + PAN / 2;
    }
    volg(wie, cursor, d.tot);
    if (punten.length >= 2) {
      const xs = punten.map((p) => p.x);
      const bereik = Math.max(...xs) - Math.min(...xs);
      sh.spreiding = bereik;
      if (bereik >= 0.05 || pannen.length) {
        // Licht gladgestreken, behalve rond de pannen (die moeten snel blijven).
        sh.spoor = punten.map((p, i) => {
          if (pannen.some((pan) => Math.abs(pan.t - p.t) <= PAN)) return p;
          const buren = punten.slice(Math.max(0, i - 2), i + 3).filter((q) => !pannen.some((pan) => Math.abs(pan.t - q.t) <= PAN));
          return { t: p.t, x: buren.reduce((t, q) => t + q.x, 0) / buren.length };
        });
      }
    } else {
      sh.spreiding = 0;
    }
  };

  // Volgnummers strikt tussen dit shot en het volgende: de render sorteert
  // op volgnummer. Met volgorde + i/(n+1) belandde een deel van shot 2,5
  // voorbij shot 3 — beeld én ondertitels op de verkeerde plek.
  const ruimte = (opties.volgendeVolgorde ?? seg.volgorde + 1) - seg.volgorde;
  const stap = Math.min(0.01, (ruimte * 0.8) / (delen.length + 1));
  // De uitgangstoestand vóór het eerste deel zijn kader krijgt: een deel
  // zonder gevonden persoon (een graphic, een beeld zonder gezicht) mag niet
  // het kader van de spreker uit het eerste deel erven.
  const origineel: Shot = { ...seg };
  const uit: Shot[] = [];
  delen.forEach((d, i) => {
    if (i === 0) {
      seg.end = d.tot;
      if (delen.length > 1) {
        seg.exact = false;
        seg.zachtEind = false;
      }
      kader(seg, d);
      uit.push(seg);
      return;
    }
    const deel: Shot = {
      ...origineel,
      sprekerBepaald: undefined,
      volgorde: Math.round((seg.volgorde + i * stap) * 1e6) / 1e6,
      start: d.van,
      end: d.tot,
      // Het anker hoort bij het hele fragment; een deel begint midden erin.
      ankerStart: d.van,
      ankerEind: i === delen.length - 1 ? seg.ankerEind : d.tot,
      exact: false,
      zachtBegin: false,
      zachtEind: i === delen.length - 1 ? seg.zachtEind : false,
      beeld_effect: 'geen',
      sfx: 'geen',
      tekstkaart: undefined,
      scenes: undefined,
    };
    (deel as { subKnip?: boolean }).subKnip = true;
    kader(deel, d);
    uit.push(deel);
  });
  if (delen.length > 1) seg.ankerEind = delen[0].tot;
  return { gezichten, wissels, delen: uit };
}

/** De meting via gezichten.py --sprekers, voor meerdere bereiken in één proces. */
export async function meetSprekers(
  bron: string,
  bereiken: { van: number; tot: number }[],
  python: { cmd: string; voor: string[] },
): Promise<SprekerMeting[]> {
  const stap = instelling('SPREKER_STAP');
  const uit = await new Promise<string>((klaar, fout) => {
    const kind = spawn(python.cmd, [...python.voor, 'scripts/gezichten.py', bron, '--sprekers', JSON.stringify(bereiken.map((b) => ({ ...b, stap })))], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    kind.stdout.on('data', (d) => (stdout += d));
    kind.stderr.on('data', (d) => (stderr += d));
    kind.on('error', fout);
    kind.on('close', (code) => (code === 0 ? klaar(stdout) : fout(new Error(`gezichten.py --sprekers exit ${code}: ${stderr.trim().slice(-160)}`))));
  });
  const regel = uit
    .split('\n')
    .map((r) => r.trim())
    .reverse()
    .find((r) => r.startsWith('['));
  return JSON.parse(regel || '[]') as SprekerMeting[];
}
