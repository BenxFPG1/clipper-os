import type { ClipVoorProject, Marker } from './fcpxml';
import type { Shot } from './index';
import { maakVarianten } from './varianten';

export type PlanClip = {
  titel_intern: string;
  shots: Shot[];
  hook?: { tekst_overlay?: string };
  caption?: { tiktok?: string };
};

/**
 * Zet een clip-plan om in de sequences van het Premiere-project. Drie lagen,
 * van overzicht naar detail:
 *
 * 1. "00 - BRON met knippunten": de hele video ongeknipt op de tijdlijn, met
 *    per clip een gemarkeerd bereik. Zo zie je in één blik waar de clips in de
 *    aflevering zitten en kun je zelf beslissen of je ruimer of krapper knipt.
 * 2. Per clip een sequence met de shots al geknipt, en op elke knip een marker
 *    met de functie (hook, barst, payoff) en de edit-notitie uit het plan.
 * 3. Per clip de mechanische varianten (kort skelet, ander anker, part 1/2).
 */
export function bouwSequences(
  clips: PlanClip[],
  opties: { metVarianten?: boolean; videoDuur?: number | null } = {},
): ClipVoorProject[] {
  const sequences: ClipVoorProject[] = [];
  const letters = 'bcdefgh';

  // 1. Overzicht: de bron met per clip een gemarkeerd bereik.
  if (opties.videoDuur && opties.videoDuur > 0 && clips.length > 0) {
    // Eén marker per knippunt, niet per clip: clips combineren fragmenten die
    // ver uit elkaar liggen, dus een bereik van eerste tot laatste shot zou
    // bijna de hele aflevering omvatten en niets aanwijzen. Nu zie je precies
    // welke stukken je nodig hebt en voor welke clip.
    const markers: Marker[] = clips
      .flatMap((c, i) =>
        [...c.shots]
          .sort((a, b) => a.volgorde - b.volgorde)
          .map((shot) => ({
            start: shot.start,
            end: shot.end,
            naam: `${String(i + 1).padStart(2, '0')}.${shot.volgorde} ${shot.functie} — ${c.titel_intern}`,
            notitie: [
              shot.volgorde === 1 && c.hook?.tekst_overlay ? `Hook: ${c.hook.tekst_overlay}` : null,
              shot.edit_notitie,
            ]
              .filter(Boolean)
              .join(' | '),
          })),
      )
      .sort((a, b) => a.start - b.start);

    sequences.push({
      nummer: 0,
      titel: 'BRON met knippunten',
      label: '00 - BRON met knippunten',
      shots: [],
      doorlopend: { start: 0, end: opties.videoDuur },
      markers,
    });
  }

  // 2 en 3: per clip de montage, daarna de varianten.
  for (const [i, c] of clips.entries()) {
    const nr = String(i + 1).padStart(2, '0');
    sequences.push({
      nummer: i + 1,
      titel: c.titel_intern,
      shots: c.shots,
      label: `${nr} - ${c.titel_intern}`,
      markers: shotMarkers(c.shots),
    });

    if (opties.metVarianten === false) continue;
    for (const [v, variant] of maakVarianten(c.shots).entries()) {
      sequences.push({
        nummer: i + 1,
        titel: c.titel_intern,
        shots: variant.shots,
        label: `${nr}${letters[v] ?? 'x'} - ${c.titel_intern} — ${variant.naam}`,
        markers: shotMarkers(variant.shots, variant.toelichting),
      });
    }
  }

  return sequences;
}

/**
 * Eén marker per knip, op het punt waar het shot begint. In de tijdlijn zie je
 * daardoor bij elke naad wat de functie is en wat er nog moet gebeuren.
 */
function shotMarkers(shots: Shot[], kop?: string): Marker[] {
  const gesorteerd = [...shots].sort((a, b) => a.volgorde - b.volgorde);
  let cursor = 0;
  const markers: Marker[] = [];

  if (kop) {
    markers.push({ start: 0, naam: 'Aanpak van deze variant', notitie: kop });
  }

  for (const shot of gesorteerd) {
    const duur = Math.max(0, shot.end - shot.start);
    markers.push({
      start: cursor,
      end: cursor + duur,
      naam: shot.functie,
      notitie: [
        shot.edit_notitie,
        `bron ${fmt(shot.start)}–${fmt(shot.end)}`,
      ]
        .filter(Boolean)
        .join(' | '),
    });
    cursor += duur;
  }

  return markers;
}

function fmt(seconden: number): string {
  const s = Math.max(0, Math.round(seconden));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
