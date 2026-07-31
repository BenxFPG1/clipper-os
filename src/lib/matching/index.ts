import { TranscriptSegment } from '../ingest/transcript';

export type BronMatch = {
  video_id: string;
  video_titel: string;
  start_seconds: number;
  end_seconds: number;
  /** 0-1: welk deel van de woorden uit de clip we in dit venster terugvonden. */
  score: number;
  /** Het stuk brontranscript dat overeenkomt, om te controleren. */
  fragment: string;
};

/**
 * Zoekt terug uit welk moment van een lange bronvideo een korte clip geknipt is.
 *
 * Dit is waar research pas echt iets oplevert: je ziet niet alleen dát een clip
 * werkte, maar wélk moment iemand uit een uur materiaal koos. Precies die keuze
 * is wat een goede clipper onderscheidt.
 *
 * We doen dit met woordoverlap in plaats van een LLM: het is deterministisch,
 * gratis, en bij letterlijk overgenomen audio ruimschoots nauwkeurig genoeg.
 */
export function matchClipInTranscript(
  clipTekst: string,
  transcript: TranscriptSegment[],
  opties?: { minScore?: number },
): { start_seconds: number; end_seconds: number; score: number; fragment: string } | null {
  const clipWoorden = normaliseer(clipTekst);
  if (clipWoorden.length < 5 || transcript.length === 0) return null;

  const clipSet = new Set(clipWoorden);
  // Een clip beslaat meestal 20-90 seconden bron. We schuiven een venster van
  // ongeveer die lengte over het transcript en kijken waar de woorden landen.
  const clipDuurSchatting = Math.max(15, Math.min(120, clipWoorden.length / 2.5));

  let beste: { start: number; end: number; score: number; fragment: string } | null = null;

  for (let i = 0; i < transcript.length; i++) {
    const start = transcript[i].start_seconds;
    const stukken: string[] = [];
    let j = i;

    while (j < transcript.length && transcript[j].end_seconds - start <= clipDuurSchatting) {
      stukken.push(transcript[j].text);
      j++;
    }
    if (stukken.length === 0) continue;

    const vensterWoorden = normaliseer(stukken.join(' '));
    if (vensterWoorden.length === 0) continue;

    // Hoeveel van de clipwoorden komen in dit venster voor? We tellen unieke
    // woorden, zodat veelvoorkomende stopwoorden niet doorslaggevend worden.
    const vensterSet = new Set(vensterWoorden);
    let raak = 0;
    for (const woord of clipSet) if (vensterSet.has(woord)) raak++;
    const score = raak / clipSet.size;

    if (!beste || score > beste.score) {
      beste = {
        start,
        end: transcript[Math.min(j, transcript.length) - 1].end_seconds,
        score,
        fragment: stukken.join(' ').slice(0, 600),
      };
    }
  }

  const drempel = opties?.minScore ?? 0.35;
  if (!beste || beste.score < drempel) return null;

  return {
    start_seconds: Math.round(beste.start),
    end_seconds: Math.round(beste.end),
    score: Math.round(beste.score * 100) / 100,
    fragment: beste.fragment,
  };
}

/** Zoekt de clip in meerdere bronvideo's en geeft de beste treffer terug. */
export function matchClipInVideos(
  clipTekst: string,
  videos: { id: string; title: string; transcript: TranscriptSegment[] }[],
  opties?: { minScore?: number },
): BronMatch | null {
  let beste: BronMatch | null = null;

  for (const video of videos) {
    const treffer = matchClipInTranscript(clipTekst, video.transcript, opties);
    if (!treffer) continue;
    if (!beste || treffer.score > beste.score) {
      beste = { video_id: video.id, video_titel: video.title, ...treffer };
    }
  }

  return beste;
}

/**
 * Haalt de gesproken tekst uit een WEBVTT-transcript. ScrapeCreators levert
 * ondertitels in dat formaat; wij willen alleen de woorden.
 */
export function vttNaarTekst(vtt: string): string {
  return vtt
    .split('\n')
    .filter((regel) => {
      const r = regel.trim();
      if (!r || r === 'WEBVTT') return false;
      if (r.includes('-->')) return false;
      if (/^\d+$/.test(r)) return false;
      return true;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Kleine, veelvoorkomende woorden zeggen niets over wélk moment het is. */
const STOPWOORDEN = new Set([
  'de', 'het', 'een', 'en', 'van', 'in', 'is', 'dat', 'die', 'te', 'op', 'met', 'voor', 'niet',
  'ik', 'je', 'we', 'ze', 'er', 'aan', 'ook', 'als', 'maar', 'om', 'dan', 'nog', 'wel', 'wat',
  'the', 'a', 'to', 'of', 'and', 'is', 'in', 'it', 'you', 'that',
]);

function normaliseer(tekst: string): string[] {
  return tekst
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWOORDEN.has(w));
}
