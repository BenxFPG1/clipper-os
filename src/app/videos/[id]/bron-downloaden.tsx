'use client';

import { useState } from 'react';

/**
 * De bronvideo halen voor het Premiere-project. Die 200-500MB gaat bewust niet
 * via de site: dat is precies waar serverless op stukloopt (tijd en geheugen),
 * en YouTube levert hem sneller rechtstreeks. Daarom: één commando dat het
 * bestand meteen goed neerzet als bron.mp4 naast je project.
 */
export function BronDownloaden({ videoId, sourceUrl }: { videoId: string; sourceUrl: string | null }) {
  const [gekopieerd, setGekopieerd] = useState<string | null>(null);

  if (!sourceUrl) {
    return (
      <p className="text-sm text-neutral-500">
        Deze video heeft geen bron-URL, dus de bron is niet automatisch op te halen.
      </p>
    );
  }

  const ytdlp = `yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]/b" --merge-output-format mp4 -o bron.mp4 "${sourceUrl}"`;
  const viaTool = `npm run project -- ${videoId}`;

  async function kopieer(tekst: string, welke: string) {
    await navigator.clipboard.writeText(tekst);
    setGekopieerd(welke);
    setTimeout(() => setGekopieerd(null), 2000);
  }

  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-neutral-400">Snelste weg — bron ophalen in de map van je project:</span>
          <button
            onClick={() => kopieer(ytdlp, 'ytdlp')}
            className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-900"
          >
            {gekopieerd === 'ytdlp' ? 'gekopieerd' : 'kopieer'}
          </button>
        </div>
        <code className="block overflow-x-auto rounded bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
          {ytdlp}
        </code>
      </div>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-neutral-400">
            Of alles in één keer (bron + .xml in ~/Movies/Clipper OS, met gemeten framerate):
          </span>
          <button
            onClick={() => kopieer(viaTool, 'tool')}
            className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-900"
          >
            {gekopieerd === 'tool' ? 'gekopieerd' : 'kopieer'}
          </button>
        </div>
        <code className="block overflow-x-auto rounded bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
          {viaTool}
        </code>
      </div>

      <p className="text-xs text-neutral-500">
        Het projectbestand verwijst naar <code>bron.mp4</code> ernaast. Heet het bestand anders of staat het
        elders, dan vraagt Premiere bij het openen één keer om te relinken — daarna kloppen alle cuts.{' '}
        <a href={sourceUrl} target="_blank" rel="noreferrer" className="underline hover:text-neutral-300">
          Bron op YouTube openen
        </a>
      </p>
    </div>
  );
}
