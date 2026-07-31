'use client';

import { useEffect, useState } from 'react';

type Download = { naam: string; bytes: number; url: string | null };
type Job = {
  id: string;
  status: 'wachtend' | 'bezig' | 'klaar' | 'mislukt';
  clip_index: number | null;
  fout: string | null;
  created_at: string;
  downloads: Download[];
};

const STATUS_TEKST: Record<Job['status'], string> = {
  wachtend: 'in de wachtrij',
  bezig: 'bezig met monteren…',
  klaar: 'klaar om te downloaden',
  mislukt: 'mislukt',
};

/**
 * Ruwe montages aanvragen en downloaden. De site rendert niet zelf (geen ffmpeg
 * op serverless); hij zet een opdracht klaar die in de cloud wordt opgepakt.
 */
export function RenderPanel({ videoId, aantalClips }: { videoId: string; aantalClips: number }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);
  const [clip, setClip] = useState<string>('alle');

  async function laad() {
    const res = await fetch(`/api/renders?video_id=${videoId}`);
    if (res.ok) setJobs((await res.json()).jobs ?? []);
  }

  useEffect(() => {
    laad();
    // Zolang er iets loopt willen we de status vanzelf zien bijwerken.
    const timer = setInterval(laad, 20_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  async function vraagAan() {
    setBusy(true);
    setMelding(null);
    const res = await fetch('/api/renders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ video_id: videoId, clip_index: clip === 'alle' ? null : Number(clip) }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMelding(json.error ?? 'Aanvragen mislukt');
      return;
    }
    setMelding(
      json.melding ??
        (json.direct_gestart
          ? 'Opdracht klaargezet — de cloud is direct gestart.'
          : 'Opdracht klaargezet. De montage wordt binnen een kwartier opgepakt.'),
    );
    laad();
  }

  return (
    <section className="space-y-3 rounded border border-neutral-800 p-4">
      <div>
        <h2 className="text-lg font-medium">Ruwe montages</h2>
        <p className="mt-1 text-sm text-neutral-500">
          De fragmenten uit het plan achter elkaar gezet, verticaal, klaar om in CapCut af te maken. Het monteren
          gebeurt in de cloud; je krijgt hier een downloadlink.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="text-neutral-400">Welke clips</span>
          <select
            value={clip}
            onChange={(e) => setClip(e.target.value)}
            className="mt-1 block rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          >
            <option value="alle">alle {aantalClips} clips</option>
            {Array.from({ length: aantalClips }, (_, i) => (
              <option key={i + 1} value={String(i + 1)}>
                alleen clip {i + 1}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={vraagAan}
          disabled={busy}
          className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
        >
          {busy ? 'Bezig…' : 'Montage aanvragen'}
        </button>
      </div>

      {melding && <p className="text-sm text-neutral-400">{melding}</p>}

      {jobs.length > 0 && (
        <ul className="space-y-2">
          {jobs.map((job) => (
            <li key={job.id} className="rounded border border-neutral-800 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {job.clip_index ? `Clip ${job.clip_index}` : 'Alle clips'}
                  <span className="ml-2 text-xs text-neutral-500">
                    {new Date(job.created_at).toLocaleString('nl-NL')}
                  </span>
                </span>
                <span
                  className={`text-xs ${
                    job.status === 'klaar'
                      ? 'text-emerald-300'
                      : job.status === 'mislukt'
                        ? 'text-red-400'
                        : 'text-neutral-400'
                  }`}
                >
                  {STATUS_TEKST[job.status]}
                </span>
              </div>

              {job.fout && <p className="mt-1 text-xs text-red-400">{job.fout}</p>}

              {job.downloads.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {job.downloads.map((d) => (
                    <li key={d.naam}>
                      {d.url ? (
                        <a href={d.url} download className="text-xs underline hover:text-neutral-100">
                          {d.naam}
                        </a>
                      ) : (
                        <span className="text-xs text-neutral-500">{d.naam}</span>
                      )}
                      <span className="ml-2 text-xs text-neutral-600">{Math.round(d.bytes / 1e6)} MB</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
