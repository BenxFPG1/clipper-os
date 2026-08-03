import type { PlanShot } from './project-opbouw';

export type TranscriptSegment = { start_seconds: number; end_seconds: number; text: string };

/**
 * Bouwt een ondertitelbestand (.srt) voor één clip uit het transcript dat we al
 * hebben. Premiere kan zelf transcriberen, maar dat is dubbel werk: wij weten
 * al wat er gezegd wordt én welke fragmenten in welke volgorde op de tijdlijn
 * staan. De tijden worden omgerekend naar de positie in de montage, dus de
 * ondertiteling loopt meteen synchroon.
 *
 * Regels worden opgeknipt op ongeveer 42 tekens: langer leest niet prettig op
 * een telefoon en valt bij verticale video buiten beeld.
 */
export function bouwSrt(shots: PlanShot[], transcript: TranscriptSegment[], maxTekens = 42): string {
  const gesorteerd = [...shots].sort((a, b) => a.volgorde - b.volgorde);
  const regels: { van: number; tot: number; tekst: string }[] = [];
  let cursor = 0;

  for (const shot of gesorteerd) {
    const duur = Math.max(0, shot.end - shot.start);
    const overlappend = transcript
      .filter((s) => s.end_seconds > shot.start && s.start_seconds < shot.end)
      .sort((a, b) => a.start_seconds - b.start_seconds);

    for (const seg of overlappend) {
      // Naar tijdlijnpositie: begin van het segment binnen dit shot, plus alles
      // wat er in de montage aan voorafgaat.
      const van = cursor + Math.max(0, seg.start_seconds - shot.start);
      const tot = cursor + Math.min(duur, seg.end_seconds - shot.start);
      if (tot <= van) continue;

      for (const stuk of splitsTekst(seg.text.trim(), maxTekens, van, tot)) {
        regels.push(stuk);
      }
    }
    cursor += duur;
  }

  return opschonen(regels)
    .map((r, i) => `${i + 1}\n${tijd(r.van)} --> ${tijd(r.tot)}\n${r.tekst}\n`)
    .join('\n');
}

/**
 * YouTube-ondertitels rollen: opeenvolgende segmenten overlappen elkaar in tijd
 * en herhalen woorden. Eén op één overnemen levert regels op die door elkaar
 * heen lopen. Daarom: op volgorde zetten, overlap wegnemen, herhalingen en te
 * korte flitsen eruit.
 */
function opschonen(
  regels: { van: number; tot: number; tekst: string }[],
): { van: number; tot: number; tekst: string }[] {
  const MIN_DUUR = 0.6;
  const gesorteerd = [...regels].sort((a, b) => a.van - b.van || a.tot - b.tot);
  const uit: { van: number; tot: number; tekst: string }[] = [];

  for (const r of gesorteerd) {
    const vorige = uit[uit.length - 1];
    if (!r.tekst) continue;
    if (vorige && normaliseer(vorige.tekst) === normaliseer(r.tekst)) continue;

    const van = vorige ? Math.max(r.van, vorige.tot) : r.van;
    const tot = Math.max(r.tot, van + MIN_DUUR);
    if (tot - van < 0.2) continue;

    // De vorige regel mag niet over deze heen lopen.
    if (vorige && vorige.tot > van) vorige.tot = van;
    uit.push({ van, tot, tekst: r.tekst });
  }

  return uit;
}

function normaliseer(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Lange zinnen opknippen, met de tijd evenredig verdeeld over de stukken. */
function splitsTekst(
  tekst: string,
  maxTekens: number,
  van: number,
  tot: number,
): { van: number; tot: number; tekst: string }[] {
  if (tekst.length <= maxTekens) return [{ van, tot, tekst }];

  const woorden = tekst.split(/\s+/);
  const stukken: string[] = [];
  let huidig = '';
  for (const w of woorden) {
    if ((huidig + ' ' + w).trim().length > maxTekens && huidig) {
      stukken.push(huidig.trim());
      huidig = w;
    } else {
      huidig = `${huidig} ${w}`.trim();
    }
  }
  if (huidig) stukken.push(huidig);

  const perStuk = (tot - van) / stukken.length;
  return stukken.map((s, i) => ({ van: van + i * perStuk, tot: van + (i + 1) * perStuk, tekst: s }));
}

function tijd(seconden: number): string {
  const ms = Math.max(0, Math.round(seconden * 1000));
  const u = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(u)}:${p(m)}:${p(s)},${p(rest, 3)}`;
}
