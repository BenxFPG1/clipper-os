export type TranscriptSegment = {
  start_seconds: number;
  end_seconds: number;
  text: string;
};

/** "1:02:07" | "16:36" | "7" → seconden */
export function parseTimecode(raw: string): number | null {
  const parts = raw.trim().split(':');
  if (parts.some((p) => p === '' || Number.isNaN(Number(p)))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/**
 * Parseert een handmatig geplakt transcript. Ondersteunt regels als:
 *   0:07 tekst
 *   [0:07] tekst
 *   00:00:07 - 00:00:12  tekst
 * Regels zonder tijdcode worden aan het vorige segment geplakt.
 */
export function parseManualTranscript(raw: string): TranscriptSegment[] {
  const lineRe = /^\s*\[?(\d{1,2}(?::\d{2}){0,2})\]?(?:\s*[-–]\s*\[?(\d{1,2}(?::\d{2}){0,2})\]?)?\s*[:\-–)]?\s*(.*)$/;
  const segments: TranscriptSegment[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(lineRe);
    const start = match ? parseTimecode(match[1]) : null;

    if (match && start !== null) {
      const end = match[2] ? parseTimecode(match[2]) : null;
      segments.push({
        start_seconds: start,
        end_seconds: end ?? start,
        text: match[3].trim(),
      });
    } else if (segments.length > 0) {
      segments[segments.length - 1].text += ` ${line.trim()}`;
    }
  }

  return closeOpenEnds(segments);
}

/**
 * Segmenten zonder eigen eindtijd krijgen de starttijd van het volgende segment.
 * Het laatste segment krijgt een schatting op basis van de tekstlengte
 * (ongeveer 15 tekens per seconde spraak).
 */
export function closeOpenEnds(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.map((seg, i) => {
    if (seg.end_seconds > seg.start_seconds) return seg;
    const next = segments[i + 1];
    const fallback = next ? next.start_seconds : seg.start_seconds + Math.max(2, seg.text.length / 15);
    return { ...seg, end_seconds: Math.round(fallback) };
  });
}

/** Compacte weergave voor in de prompt: [start-end] tekst */
export function renderTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => `[${Math.round(s.start_seconds)}-${Math.round(s.end_seconds)}] ${s.text}`)
    .join('\n');
}

export function transcriptDuration(segments: TranscriptSegment[]): number {
  return segments.reduce((max, s) => Math.max(max, s.end_seconds), 0);
}
