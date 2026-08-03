import type { ClipVoorProject, Marker } from './fcpxml';
import type { Shot } from './index';
import { maakVarianten } from './varianten';

export type PlanShot = Shot & { transcript_fragment?: string };

export type PlanClip = {
  titel_intern: string;
  shots: PlanShot[];
  structure_type?: string;
  verwachte_sterkte?: string;
  hook?: { type?: string; tekst_overlay?: string; gesproken_start?: string };
  context_kaart?: string | null;
  caption?: { tiktok?: string; reels?: string; shorts?: string };
  verplichte_elementen?: string[];
  waarom_dit_werkt?: string;
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
      // Briefing bovenaan, daarna per knip wat er gezegd wordt: zo staat het
      // hele script in het Markers-paneel en hoef je niet te wisselen tussen
      // Premiere en de browser.
      markers: [briefingMarker(c), ...shotMarkers(c.shots)],
    });

    if (opties.metVarianten === false) continue;
    for (const [v, variant] of maakVarianten(c.shots).entries()) {
      sequences.push({
        nummer: i + 1,
        titel: c.titel_intern,
        shots: variant.shots,
        label: `${nr}${letters[v] ?? 'x'} - ${c.titel_intern} — ${variant.naam}`,
        markers: [briefingMarker(c, variant.toelichting), ...shotMarkers(variant.shots)],
      });
    }
  }

  return sequences;
}

/**
 * De hele briefing als één marker op frame 0. In het Markers-paneel van
 * Premiere lees je zo per sequence het complete script: hook, caption,
 * verplichte elementen en de onderbouwing.
 */
function briefingMarker(clip: PlanClip, variantToelichting?: string): Marker {
  const regels = [
    variantToelichting ? `VARIANT: ${variantToelichting}` : null,
    clip.hook?.tekst_overlay ? `HOOK-OVERLAY: ${clip.hook.tekst_overlay}` : null,
    clip.hook?.gesproken_start ? `AUDIO START: "${clip.hook.gesproken_start}"` : null,
    clip.context_kaart ? `CONTEXTKAART: ${clip.context_kaart}` : null,
    clip.caption?.tiktok ? `CAPTION TIKTOK: ${clip.caption.tiktok}` : null,
    clip.caption?.reels ? `CAPTION REELS: ${clip.caption.reels}` : null,
    clip.caption?.shorts ? `CAPTION SHORTS: ${clip.caption.shorts}` : null,
    clip.verplichte_elementen?.length ? `VERPLICHT: ${clip.verplichte_elementen.join(' · ')}` : null,
    clip.structure_type ? `STRUCTUUR: ${clip.structure_type}` : null,
    clip.waarom_dit_werkt ? `WAAROM: ${clip.waarom_dit_werkt}` : null,
  ].filter(Boolean);

  return { start: 0, naam: `BRIEFING — ${clip.titel_intern}`, notitie: regels.join('\n') };
}

/**
 * Eén marker per knip, op het punt waar het shot begint. In de tijdlijn zie je
 * bij elke naad wat de functie is, wat er gezegd wordt en wat er moet gebeuren.
 */
function shotMarkers(shots: PlanShot[]): Marker[] {
  const gesorteerd = [...shots].sort((a, b) => a.volgorde - b.volgorde);
  let cursor = 0;
  const markers: Marker[] = [];

  for (const shot of gesorteerd) {
    const duur = Math.max(0, shot.end - shot.start);
    markers.push({
      start: cursor,
      end: cursor + duur,
      naam: shot.functie,
      notitie: [
        shot.transcript_fragment ? `"${shot.transcript_fragment}"` : null,
        shot.edit_notitie,
        `bron ${fmt(shot.start)}–${fmt(shot.end)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
    cursor += duur;
  }

  return markers;
}

function fmt(seconden: number): string {
  const s = Math.max(0, Math.round(seconden));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
