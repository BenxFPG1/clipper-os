'use client';

import { useState } from 'react';

/**
 * Ondertiteling per clip als .srt. Sneller dan Premiere zelf laten
 * transcriberen: de tekst staat al vast en klopt met het plan, dus je hoeft
 * niets te corrigeren — importeren en stylen is genoeg.
 */
export function CaptionsDownload({ videoId, clips }: { videoId: string; clips: string[] }) {
  const [clip, setClip] = useState('1');

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2 text-neutral-400">
        Ondertiteling voor
        <select
          value={clip}
          onChange={(e) => setClip(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
        >
          {clips.map((titel, i) => (
            <option key={i} value={String(i + 1)}>
              {String(i + 1).padStart(2, '0')} — {titel.slice(0, 45)}
            </option>
          ))}
        </select>
      </label>
      <a
        href={`/api/videos/${videoId}/captions?clip=${clip}`}
        download
        className="rounded border border-neutral-700 px-3 py-1.5 hover:bg-neutral-900"
      >
        .srt downloaden
      </a>
      <span className="text-xs text-neutral-500">
        In Premiere: Text-paneel → Captions → Import captions from file.
      </span>
    </div>
  );
}
