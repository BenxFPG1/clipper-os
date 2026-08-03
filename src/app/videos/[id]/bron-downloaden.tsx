'use client';

import { useState } from 'react';

/**
 * De bronvideo halen voor het Premiere-project. Die 200-500MB gaat bewust niet
 * via de site: dat is precies waar serverless op stukloopt (tijd en geheugen),
 * en YouTube levert hem sneller rechtstreeks. Daarom: één commando dat het
 * bestand meteen goed neerzet als bron.mp4 naast je project.
 */
export function BronDownloaden({
  videoId,
  sourceUrl,
  toolPad,
}: {
  videoId: string;
  sourceUrl: string | null;
  /** Map waar de tool staat, zodat het commando in één keer plakbaar is. */
  toolPad: string;
}) {
  const [gekopieerd, setGekopieerd] = useState<string | null>(null);

  if (!sourceUrl) {
    return (
      <p className="text-sm text-neutral-500">
        Deze video heeft geen bron-URL, dus de bron is niet automatisch op te halen.
      </p>
    );
  }

  // H.264 (avc1) én AAC-audio (m4a) afdwingen. YouTube levert standaard
  // AV1-video en Opus-audio; Premiere weigert allebei — de video met
  // "unsupported compression type av01", de audio met "does not match
  // original type" bij het relinken.
  const ytdlp = `yt-dlp -f 'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[vcodec^=avc1][height<=1080]/bv*[height<=1080]+ba[ext=m4a]/b' --merge-output-format mp4 -o bron.mp4 "${sourceUrl}"`;
  // Inclusief de cd, zodat het één plakactie is vanuit elke map.
  const viaTool = `cd "${toolPad}" && npm run project -- ${videoId}`;

  async function kopieer(tekst: string, welke: string) {
    await navigator.clipboard.writeText(tekst);
    setGekopieerd(welke);
    setTimeout(() => setGekopieerd(null), 2000);
  }

  return (
    <div className="space-y-3 text-sm">
      <ol className="list-inside list-decimal space-y-0.5 rounded bg-neutral-900/60 px-3 py-2 text-xs text-neutral-400">
        <li>Open Terminal (Cmd+spatie, typ &quot;Terminal&quot;).</li>
        <li>
          Typ <code className="text-neutral-300">cd</code> met een spatie erachter, sleep de map uit Finder het
          venster in, en druk op <span className="text-neutral-300">Enter</span> — eerst dit, pas daarna het
          commando. Plak je beide op één regel, dan krijg je &quot;cd: too many arguments&quot;.
        </li>
        <li>Plak het commando hieronder en druk op Enter. Klaar als de prompt terugkomt.</li>
      </ol>

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
            Of alles in één keer, vanuit welke map dan ook — bron + .xml samen in ~/Movies/Clipper OS, met de
            juiste framerate en alle markers:
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
