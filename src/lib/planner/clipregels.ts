import { instelling } from '../roughcut/instellingen';
import type { TranscriptSegment } from '../ingest/transcript';
import type { Clip, ClipPlan, Energiemoment } from './schema';
import { dodeWoorden, instappuntKwaliteit, lachmarkers } from './signalen';

/**
 * Harde inhoudsregels voor een clip — de lessen uit vijf volledig
 * getranscribeerde renders. Technisch klopten ze, inhoudelijk niet:
 *
 *  - te lang met vulling (48 s waarvan 15 s een uitweiding; 52 s met twee
 *    aan elkaar geplakte verhalen), terwijl ze op 25–30 s sterker waren;
 *  - slappe eindes ("Ik ben benieuwd wat jij hiervan vindt", een
 *    informatief nazinnetje na de payoff);
 *  - openingen zonder context ("En dan Scar japt hem, toch?");
 *  - comedy te traag, het sterkste moment afgekapt.
 *
 * Mechanisch waar het kan (lengte, afsluiters, instappunt), als signaal waar
 * het een oordeel is (twee verhalen, herhaling, schrapkandidaten). De
 * prompts eisen hetzelfde; dit is de vangrail erachter.
 */

export type Formaat = 'comedy' | 'interview' | 'uitleg';

/**
 * Het format bij een campagnethema. Zonder thema mag een terugvaltekst
 * (campagnenaam + videotitel) het bepalen; onbekend → interview (het
 * middelste bereik).
 */
export function formaatVoorThema(thema: string | null | undefined, terugval?: string | null): Formaat {
  // "all" is de vault zonder thema: dan beslist de terugval.
  const eigen = thema && thema.toLowerCase() !== 'all' ? thema : '';
  const t = (eigen || terugval || '').toLowerCase();
  if (/comedy|humor|entertain|mukbang|grap|sketch|prank|vlog|reality/.test(t)) return 'comedy';
  if (/financ|beleg|geld|crypto|edelmeta|goud|gold|zilver|platina|macro|uitleg|educat|kennis|tech|wetenschap|economie|business|ondernem/.test(t)) return 'uitleg';
  return 'interview';
}

/** Doelbereik (s) per format; instelbaar via MONTAGE_CLIP_LENGTE_<FORMAT>_<MIN|MAX>. */
export function lengteBereik(f: Formaat): { min: number; max: number } {
  const sleutel = f.toUpperCase() as 'COMEDY' | 'INTERVIEW' | 'UITLEG';
  return { min: instelling(`CLIP_LENGTE_${sleutel}_MIN`), max: instelling(`CLIP_LENGTE_${sleutel}_MAX`) };
}

type ShotLike = Clip['shots'][number];

export const clipDuur = (clip: Pick<Clip, 'shots'>): number => clip.shots.reduce((t, s) => t + Math.max(0, s.end - s.start), 0);

/** Zinnen van een fragment (op ., !, ?, …), met hun aandeel in tekens. */
export function zinnen(tekst: string): string[] {
  return tekst
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .map((z) => z.trim())
    .filter(Boolean);
}

const kaal = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Generieke YouTube-/podcastafsluiters en lege slotzinnetjes. */
const AFSLUITERS: RegExp[] = [
  /\b(ik ben|we zijn) (heel |erg |echt )?benieuwd (naar )?wat (jij|jullie|je) (er|hier|daar)?(van|over)? ?(vindt|vinden|denkt|denken)\b/,
  /\bwat (vind|denk|vinden|denken) (jij|jullie)( ervan| hiervan| daarvan| erover)?\b$/,
  /\blaat (het )?(me|mij|ons) (even )?(weten|horen)\b/,
  /\b(in|onder) de (comments|reacties|comment|beschrijving)\b|\blink in (de )?bio\b/,
  /\blike (en|&) abonneer|\babonneer\b|\bsubscribe\b|\bvolg (ons|me|mij)\b|\bdruk op (het )?belletje\b/,
  /\btot de volgende (keer|video|week|aflevering)\b|\btot (snel|volgende week|zo)\b|\bdoei\b|\bdag allemaal\b/,
  /\bbedankt voor het (kijken|luisteren)\b|\bthanks for watching\b|\bsee you next time\b/,
  /^(dus|nou|en)? ?ja\.?$/,
  /^dus (ja|dat|ehm?)\b.{0,12}$/,
  /^(nou |oké |ok )?(dat|dit) was (het|het wel|'t)\b/,
  /^(oké|ok|nou|goed|prima|zo),? (nou |dan )?(ja|dat is het|klaar)\b/,
];

/** Is dit een generieke afsluiter / leeg slotzinnetje? */
export function isAfsluiter(zin: string): boolean {
  const z = kaal(zin);
  if (!z) return true;
  return AFSLUITERS.some((re) => re.test(z));
}

/** Tekst zonder de afgekapte zinnen, met de bijbehorende tijdsverschuiving (evenredig naar tekens). */
function knipZinnen(shot: ShotLike, aantal: number, kant: 'begin' | 'eind'): ShotLike | null {
  const zs = zinnen(shot.transcript_fragment ?? '');
  if (aantal <= 0) return shot;
  if (zs.length <= aantal) return null;
  const weg = kant === 'eind' ? zs.slice(-aantal) : zs.slice(0, aantal);
  const blijft = kant === 'eind' ? zs.slice(0, -aantal) : zs.slice(aantal);
  const totaal = zs.join(' ').length || 1;
  const fractie = weg.join(' ').length / totaal;
  const duur = shot.end - shot.start;
  const r = (x: number) => Math.round(x * 100) / 100;
  return kant === 'eind'
    ? { ...shot, transcript_fragment: blijft.join(' '), end: r(shot.end - duur * fractie) }
    : { ...shot, transcript_fragment: blijft.join(' '), start: r(shot.start + duur * fractie) };
}

/**
 * Knipt een letterlijke slottekst van het einde van een shot (het
 * nazinnetje dat de verhaaldokter aanwijst). Tijd evenredig naar tekens; de
 * render lijnt daarna opnieuw uit op de woorden van het fragment. Null als
 * de tekst er niet aan het eind staat of er te weinig overblijft.
 */
export function knipSlot(shot: ShotLike, slot: string): ShotLike | null {
  const tekst = (shot.transcript_fragment ?? '').replace(/\s+/g, ' ').trim();
  const doel = kaal(slot);
  if (!doel) return null;
  const k = kaal(tekst);
  if (!k.endsWith(doel)) return null;
  // Positie in de originele tekst: vanaf achteren tellen tot dezelfde kale lengte.
  let i = tekst.length;
  while (i > 0 && kaal(tekst.slice(i - 1)).length <= doel.length) i--;
  // Leestekens vóór de geknipte tekst horen bij wat blijft ("goedkoper. Dus…").
  while (i < tekst.length && /[^\p{L}\p{N}]/u.test(tekst[i])) i++;
  const blijft = tekst.slice(0, i).trim();
  if (blijft.length < 8) return null;
  const fractie = (tekst.length - blijft.length) / tekst.length;
  const eind = Math.round((shot.end - (shot.end - shot.start) * fractie) * 100) / 100;
  if (eind - shot.start < 1) return null;
  return { ...shot, transcript_fragment: blijft, end: eind };
}

const STOP = new Set(['omdat', 'terwijl', 'eigenlijk', 'gewoon', 'hebben', 'worden', 'zeggen', 'moeten', 'kunnen', 'alleen', 'iemand', 'iedereen', 'zonder', 'tegen', 'echt', 'helemaal', 'natuurlijk']);
const inhoud = (t: string): string[] =>
  kaal(t)
    .split(' ')
    .filter((w) => w.length >= 5 && !STOP.has(w));

/**
 * Hoe functioneel is een shot voor de boog? Overlap met belofte, open vraag,
 * payoff en omslag, plus nieuwe informatie t.o.v. de andere shots, min dode
 * woorden en herhaling. Laag = schrapkandidaat.
 */
export function shotFunctie(clip: Pick<Clip, 'shots' | 'verhaallijn'>, shot: ShotLike): { waarde: number; redenen: string[] } {
  const boog = new Set(inhoud(`${clip.verhaallijn.belofte} ${clip.verhaallijn.open_vraag} ${clip.verhaallijn.payoff} ${clip.verhaallijn.omslag}`));
  const eigen = inhoud(shot.transcript_fragment ?? '');
  const anders = new Set(clip.shots.filter((s) => s !== shot).flatMap((s) => inhoud(s.transcript_fragment ?? '')));
  const redenen: string[] = [];
  const boogTreffers = eigen.filter((w) => boog.has(w) || [...boog].some((b) => b.slice(0, 6) === w.slice(0, 6))).length;
  const nieuw = eigen.filter((w) => !anders.has(w)).length;
  const dood = dodeWoorden(shot.transcript_fragment ?? '').aandeel;
  const herhaald = herhaaldeZinnen({ shots: clip.shots }).some((h) => h.shots.includes(shot.volgorde));
  let waarde = Math.min(1, boogTreffers / 3) * 0.6 + Math.min(1, nieuw / 8) * 0.4 - dood * 0.8 - (herhaald ? 0.3 : 0);
  if (boogTreffers === 0) redenen.push('geen belofte-/payoff-termen');
  if (nieuw <= 2) redenen.push('weinig nieuwe informatie');
  if (dood >= 0.15) redenen.push(`${Math.round(dood * 100)}% dode woorden`);
  if (herhaald) redenen.push('herhaalt een zin uit een ander shot');
  waarde = Math.round(waarde * 100) / 100;
  return { waarde, redenen };
}

/** Zinnen (≥ 4 woorden) die in twee shots (of twee keer in één shot) voorkomen. */
export function herhaaldeZinnen(clip: Pick<Clip, 'shots'>): { zin: string; shots: number[] }[] {
  const gezien = new Map<string, { zin: string; shots: number[] }>();
  for (const s of clip.shots) {
    for (const z of zinnen(s.transcript_fragment ?? '')) {
      const k = kaal(z);
      if (k.split(' ').length < 4) continue;
      const e = gezien.get(k) ?? { zin: z, shots: [] };
      e.shots.push(s.volgorde);
      gezien.set(k, e);
    }
  }
  return [...gezien.values()].filter((e) => e.shots.length >= 2);
}

/**
 * Twee losse verhalen in één clip? Shots in groepen die ver uit elkaar in de
 * bron liggen (> 60 s) én inhoudelijk vrijwel niets delen. Signaal, geen
 * oordeel: een callback over 20 minuten is juist goud.
 */
export function tweeVerhalen(clip: Pick<Clip, 'shots'>): string | null {
  const shots = [...clip.shots].sort((a, b) => a.volgorde - b.volgorde);
  for (let i = 1; i < shots.length; i++) {
    if (Math.abs(shots[i].start - shots[i - 1].end) < 60) continue;
    const voor = new Set(shots.slice(0, i).flatMap((s) => inhoud(s.transcript_fragment ?? '')));
    const na = shots.slice(i).flatMap((s) => inhoud(s.transcript_fragment ?? ''));
    if (na.length === 0 || voor.size === 0) continue;
    const gedeeld = na.filter((w) => voor.has(w)).length / na.length;
    if (gedeeld < 0.08) {
      return `shot ${shots[i].volgorde} springt ${Math.round(Math.abs(shots[i].start - shots[i - 1].end))} s door de bron en deelt bijna geen woorden met wat ervoor kwam (${Math.round(gedeeld * 100)}%) — twee losse verhalen? Dan één weg (of splitsen).`;
    }
  }
  return null;
}

export type ClipOordeel = {
  /** Harde fouten die na de mechanische reparatie overblijven: score ≤ 5. */
  fouten: string[];
  /** Aanwijzingen voor de verhaaldokter. */
  signalen: string[];
  /** Wat de mechanische reparatie deed. */
  ingrepen: string[];
};

/** Is de opening op zichzelf begrijpelijk? Bij comedy mag een korte cold open van de grap, mits het volgende shot de context geeft. */
function openingProbleem(clip: Pick<Clip, 'shots' | 'hook'>, formaat: Formaat): { shot: ShotLike; redenen: string[] } | null {
  const shots = [...clip.shots].sort((a, b) => a.volgorde - b.volgorde);
  let eerste = shots[0];
  if (!eerste) return null;
  const coldOpen = formaat === 'comedy' && eerste.functie === 'hook' && eerste.end - eerste.start <= 5 && /[.!?]$/.test((eerste.transcript_fragment ?? '').trim()) && Boolean(clip.hook?.tekst_overlay);
  if (coldOpen && shots[1]) eerste = shots[1];
  const instap = instappuntKwaliteit(zinnen(eerste.transcript_fragment ?? '')[0] ?? '');
  const hard = instap.redenen.filter((r) => /^begint met "|zonder antecedent/.test(r));
  return instap.oordeel === 'zwak' || hard.some((r) => /zonder antecedent|begint met "(en dan|en toen|dus|en|maar|want|toen|dan|daarna|daarom)"/.test(r))
    ? { shot: eerste, redenen: hard.length ? hard : instap.redenen }
    : null;
}

/**
 * Past de harde regels toe op één clip: knipt generieke afsluiters en
 * zwakke nazinnetjes, verplaatst een instappunt zonder context naar de
 * eerste begrijpelijke zin, en kort een te lange clip in door het minst
 * functionele shot weg te halen. Levert de gerepareerde clip en het oordeel.
 */
export function pasClipRegelsToe(
  invoer: Clip,
  formaat: Formaat,
  opties: { energie?: Energiemoment[]; transcript?: TranscriptSegment[] } = {},
): { clip: Clip; oordeel: ClipOordeel } {
  const fouten: string[] = [];
  const signalen: string[] = [];
  const ingrepen: string[] = [];
  let shots = [...invoer.shots].sort((a, b) => a.volgorde - b.volgorde).map((s) => ({ ...s }));

  // --- 3. Einde = moment --------------------------------------------------
  const laatstePayoff = () => {
    for (let i = shots.length - 1; i >= 0; i--) if (shots[i].functie === 'payoff') return i;
    return -1;
  };
  // Shots ná de payoff: alleen een niet-generieke "button" (een tweede
  // punchline) mag blijven; al het andere is een afzwakkend nazinnetje.
  {
    const p = laatstePayoff();
    if (p >= 0) {
      const na = shots.slice(p + 1);
      const weg = na.filter((s) => s.functie !== 'button' || zinnen(s.transcript_fragment ?? '').every(isAfsluiter));
      if (weg.length) {
        shots = shots.filter((s) => !weg.includes(s));
        ingrepen.push(`na de payoff weggehaald: shot ${weg.map((s) => s.volgorde).join(', ')} (nazinnetje/afsluiter)`);
      }
      const knop = shots.slice(laatstePayoff() + 1);
      const knopDuur = knop.reduce((t, s) => t + (s.end - s.start), 0);
      if (knopDuur > instelling('PAYOFF_NA_MAX') * 2) signalen.push(`na de payoff nog ${knopDuur.toFixed(1)} s "button" — is dat echt een tweede punchline, of een nazinnetje?`);
    } else {
      fouten.push('geen payoff-shot: de clip eindigt niet op een moment');
    }
  }
  // Generieke afsluitzinnen aan het eind van het laatste shot wegknippen.
  for (let ronde = 0; ronde < 3 && shots.length; ronde++) {
    const laatste = shots[shots.length - 1];
    const zs = zinnen(laatste.transcript_fragment ?? '');
    let n = 0;
    while (n < zs.length && isAfsluiter(zs[zs.length - 1 - n])) n++;
    if (n === 0) break;
    const gekort = knipZinnen(laatste, n, 'eind');
    if (gekort && gekort.end - gekort.start >= 1) {
      shots[shots.length - 1] = gekort;
      ingrepen.push(`slotzin geknipt: "${zs.slice(-n).join(' ').slice(0, 60)}"`);
      break;
    }
    if (laatste.functie === 'payoff') {
      fouten.push(`de payoff bestaat alleen uit een afsluiter ("${zs.join(' ').slice(0, 60)}")`);
      break;
    }
    shots = shots.slice(0, -1);
    ingrepen.push(`laatste shot was alleen een afsluiter ("${zs.join(' ').slice(0, 60)}"): weggehaald`);
  }
  {
    const laatste = shots[shots.length - 1];
    if (laatste && laatste.functie !== 'payoff' && laatste.functie !== 'button') {
      fouten.push(`laatste shot is "${laatste.functie}" — een clip eindigt op een punchline, onthulling, omslag of sterke uitspraak`);
    }
  }

  // --- 4. Opening zonder context-gat --------------------------------------
  {
    const probleem = openingProbleem({ shots, hook: invoer.hook }, formaat);
    if (probleem) {
      const zs = zinnen(probleem.shot.transcript_fragment ?? '');
      let k = 1;
      while (k < zs.length && instappuntKwaliteit(zs[k]).oordeel === 'zwak') k++;
      const gekort = k < zs.length ? knipZinnen(probleem.shot, k, 'begin') : null;
      if (gekort && gekort.end - gekort.start >= 2 && instappuntKwaliteit(zinnen(gekort.transcript_fragment)[0] ?? '').oordeel !== 'zwak') {
        shots = shots.map((s) => (s === probleem.shot ? gekort : s));
        ingrepen.push(`instappunt verplaatst naar een begrijpelijke zin ("${(zinnen(gekort.transcript_fragment)[0] ?? '').slice(0, 50)}"); weg: "${zs.slice(0, k).join(' ').slice(0, 50)}" (${probleem.redenen.join(', ')})`);
      } else {
        fouten.push(`opening zonder context: "${(zs[0] ?? '').slice(0, 60)}" (${probleem.redenen.join(', ')}) en geen begrijpelijke zin om op te starten`);
      }
    }
  }

  // --- 5. Comedy: het sterkste moment niet afgekapt ------------------------
  if (formaat === 'comedy' && opties.energie?.length && shots.length) {
    const laatste = shots[shots.length - 1];
    const piek = opties.energie
      .filter((e) => e.soort === 'volumepiek' && e.start > laatste.end - 0.2 && e.start <= laatste.end + 2.5)
      .sort((a, b) => b.sterkte - a.sterkte)[0];
    const lach = opties.transcript?.find((t) => t.start_seconds > laatste.end - 0.2 && t.start_seconds <= laatste.end + 2.5 && lachmarkers(t.text).length > 0);
    const eind = Math.max(piek ? piek.end + 0.3 : 0, lach ? lach.end_seconds : 0);
    if (eind > laatste.end) {
      shots[shots.length - 1] = { ...laatste, end: Math.round(eind * 100) / 100 };
      ingrepen.push(`slot verlengd tot ${eind.toFixed(1)} s: de lach/reactie na de punchline hoort erbij`);
    }
  }

  // --- 1. Lengte per format -------------------------------------------------
  const { min, max } = lengteBereik(formaat);
  const vast = (s: ShotLike, i: number) => i === 0 || s.functie === 'payoff' || s.functie === 'hook';
  let duur = clipDuur({ shots });
  while (duur > max) {
    const kandidaten = shots
      .map((s, i) => ({ s, i, f: shotFunctie({ shots, verhaallijn: invoer.verhaallijn }, s) }))
      .filter(({ s, i }) => !vast(s, i))
      // De laatste escalatie vóór de payoff draagt de spanning: alleen weg als er nog een andere is.
      .filter(({ s, i }) => !(s.functie === 'escalatie' && shots[i + 1]?.functie === 'payoff' && shots.filter((x) => x.functie === 'escalatie').length <= 1))
      .sort((a, b) => a.f.waarde - b.f.waarde);
    const weg = kandidaten[0];
    if (!weg) break;
    shots = shots.filter((s) => s !== weg.s);
    ingrepen.push(`te lang: shot ${weg.s.volgorde} (${(weg.s.end - weg.s.start).toFixed(1)} s, ${weg.s.functie}; ${weg.f.redenen.join(', ') || 'minst functioneel'}) weggehaald`);
    duur = clipDuur({ shots });
  }
  if (duur > max + 0.5) fouten.push(`${duur.toFixed(0)} s, boven het maximum van ${max} s voor ${formaat}, en niet in te korten zonder de boog te breken`);
  if (duur < min - 0.5) signalen.push(`${duur.toFixed(0)} s, korter dan ${min} s voor ${formaat} — staat de belofte er nog in?`);

  // --- 2. Eén verhaal, geen herhaling -----------------------------------------
  const twee = tweeVerhalen({ shots });
  if (twee) signalen.push(twee);
  for (const h of herhaaldeZinnen({ shots })) {
    signalen.push(`"${h.zin.slice(0, 50)}" klinkt twee keer (shot ${h.shots.join(' en ')}) — alleen houden als de herhaling de grap of de spanning is`);
  }
  for (const s of shots) {
    if (s.functie === 'payoff' || s.functie === 'hook') continue;
    const f = shotFunctie({ shots, verhaallijn: invoer.verhaallijn }, s);
    if (f.waarde < 0.15) signalen.push(`shot ${s.volgorde} (${s.functie}): ${f.redenen.join(', ') || 'weinig functie'} — zou de clip zonder dit shot slechter zijn?`);
  }

  const clip: Clip = { ...invoer, shots: shots.map((s, i) => ({ ...s, volgorde: i + 1 })) };
  // Kaarten hangen aan een shotnummer: na weghalen/hernummeren opnieuw koppelen.
  if (invoer.kaarten?.length) {
    const nieuw = new Map(shots.map((s, i) => [s.volgorde, i + 1]));
    clip.kaarten = invoer.kaarten.filter((k) => nieuw.has(k.shot)).map((k) => ({ ...k, shot: nieuw.get(k.shot)! }));
  }
  return { clip, oordeel: { fouten, signalen, ingrepen } };
}

/**
 * Het hele plan door de regels. Clips met een overgebleven harde fout krijgen
 * score ≤ 5 en vallen af (liever vier sterke clips dan negen middelmatige);
 * alleen als er dan niets over is, blijft de sterkste staan.
 */
export function pasPlanRegelsToe(
  plan: ClipPlan,
  formaat: Formaat,
  opties: { energie?: Energiemoment[]; transcript?: TranscriptSegment[]; log?: (m: string) => void } = {},
): { plan: ClipPlan; oordelen: { titel: string; oordeel: ClipOordeel }[] } {
  const oordelen: { titel: string; oordeel: ClipOordeel }[] = [];
  const clips = plan.clips.map((c) => {
    const { clip, oordeel } = pasClipRegelsToe(c, formaat, opties);
    oordelen.push({ titel: c.titel_intern, oordeel });
    if (oordeel.fouten.length && (clip.score ?? 10) > 5) clip.score = 5;
    for (const i of oordeel.ingrepen) opties.log?.(`[clipregels] "${c.titel_intern}": ${i}`);
    for (const f of oordeel.fouten) opties.log?.(`[clipregels] "${c.titel_intern}": FOUT ${f} → score ≤ 5`);
    return clip;
  });
  const blijft = clips.filter((c) => (c.score ?? 10) > 5);
  if (blijft.length === 0 && clips.length) {
    const beste = [...clips].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    opties.log?.(`[clipregels] geen clip haalt de regels; de sterkste ("${beste.titel_intern}") blijft staan om het plan niet leeg te laten`);
    return { plan: { clips: [beste] }, oordelen };
  }
  const weg = clips.length - blijft.length;
  if (weg) opties.log?.(`[clipregels] ${weg} clip(s) vallen af (score ≤ 5 na de regels)`);
  return { plan: { clips: blijft }, oordelen };
}

/** Compact voor in de verhaaldokter-prompt. */
export function regelsVoorPrompt(oordelen: { titel: string; oordeel: ClipOordeel }[], formaat: Formaat): string {
  const { min, max } = lengteBereik(formaat);
  const regels = oordelen.flatMap(({ titel, oordeel }, i) => [
    ...oordeel.fouten.map((f) => `clip ${i + 1} "${titel}": HARD — ${f}`),
    ...oordeel.signalen.map((s) => `clip ${i + 1} "${titel}": ${s}`),
    ...oordeel.ingrepen.map((g) => `clip ${i + 1} "${titel}": (al gedaan) ${g}`),
  ]);
  return `\n\n=== CLIPREGELS (format ${formaat}: ${min}–${max} s; mechanisch gemeten) ===\n${regels.length ? regels.join('\n') : '(geen opmerkingen)'}`;
}
