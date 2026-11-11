'use client';

import { useEffect, useState } from 'react';
import { roepApiAan } from '@/app/api-aanroep';
import { RenderFeedback, type Beoordeling, type Gepost } from './render-feedback';
import { AfwerkKnop } from '@/app/afwerk-knop';

type Download = {
  naam: string;
  bytes: number;
  url: string | null;
  hook_variant?: number | null;
  hook_tekst?: string | null;
  keuring_status?: 'goed' | 'review_nodig' | 'niet_getoetst' | null;
  keuring_fouten?: string[];
  /** Leerlus: jouw oordeel en of hij gepost is (met de laatste cijfers). */
  beoordeling?: Beoordeling;
  gepost?: Gepost;
};

const KEURING_TEKST: Record<NonNullable<Download['keuring_status']>, { label: string; klasse: string }> = {
  goed: { label: 'keuring goed', klasse: 'bg-emerald-900/60 text-emerald-200' },
  review_nodig: { label: 'review nodig', klasse: 'bg-amber-900/60 text-amber-200' },
  niet_getoetst: { label: 'niet getoetst', klasse: 'bg-neutral-800 text-neutral-400' },
};
type Job = {
  id: string;
  status: 'wachtend' | 'bezig' | 'klaar' | 'mislukt';
  clip_index: number | null;
  fout: string | null;
  created_at: string;
  downloads: Download[];
  voortgang: string | null;
  gedaan: number;
  totaal: number | null;
};

const STATUS_TEKST: Record<Job['status'], string> = {
  wachtend: 'in de wachtrij',
  bezig: 'bezig met monteren…',
  klaar: 'klaar',
  mislukt: 'mislukt',
};

/**
 * Clips laten maken, bekijken en beoordelen. De site rendert niet zelf (geen
 * ffmpeg op serverless); hij zet een opdracht klaar die in de cloud wordt
 * opgepakt.
 */
export function RenderPanel({ videoId, aantalClips }: { videoId: string; aantalClips: number }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);
  const [clip, setClip] = useState<string>('alle');

  async function laad() {
    const { ok, json, fout } = await roepApiAan<{ jobs?: Job[] }>(`/api/renders?video_id=${videoId}`);
    if (ok) setJobs(json.jobs ?? []);
    // Een verlopen sessie gaf anders alleen een stille, lege lijst.
    else if (fout) setMelding(fout);
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
    const { ok, json, fout } = await roepApiAan<{ melding?: string; direct_gestart?: boolean }>('/api/renders', {
      method: 'POST',
      body: { video_id: videoId, clip_index: clip === 'alle' ? null : Number(clip) },
    });
    setBusy(false);
    if (!ok) {
      setMelding(fout ?? 'Aanvragen mislukt');
      return;
    }
    setMelding(
      json.melding ??
        (json.direct_gestart
          ? 'Gestart. Een clip duurt ongeveer 6 tot 12 minuten; deze pagina werkt zichzelf bij.'
          : 'Klaargezet. Het begint binnen een uur; deze pagina werkt zichzelf bij.'),
    );
    laad();
  }

  return (
    <section className="space-y-3 rounded border border-neutral-800 p-4">
      <div>
        <h2 className="text-lg font-medium">Clips maken</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Kies welke clips uit het plan je wilt. Je krijgt per clip een verticale video met ondertitels en muziek,
          die je hier kunt bekijken, beoordelen en downloaden.
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
          {busy ? 'Bezig…' : 'Clips maken'}
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
                  {job.status === 'bezig' && job.totaal
                    ? `clip ${Math.min(job.gedaan + 1, job.totaal)}/${job.totaal}`
                    : STATUS_TEKST[job.status]}
                </span>
              </div>

              {job.status === 'bezig' && (
                <>
                  <div className="mt-2 h-1 overflow-hidden rounded bg-neutral-800">
                    <div
                      className="h-full bg-emerald-600 transition-all"
                      style={{ width: `${job.totaal ? Math.round((job.gedaan / job.totaal) * 100) : 5}%` }}
                    />
                  </div>
                  {job.voortgang && <p className="mt-1 text-xs text-neutral-500">{job.voortgang}</p>}
                </>
              )}

              {job.fout && <p className="mt-1 text-xs text-red-400">{job.fout}</p>}

              {job.downloads.length > 0 && (
                <ul className="mt-2 space-y-3">
                  {job.downloads.map((d) => (
                    <li key={d.naam}>
                      {d.url && !d.hook_variant && (
                        <video
                          src={d.url}
                          controls
                          playsInline
                          preload="metadata"
                          className="mb-2 block aspect-[9/16] w-44 rounded border border-neutral-800 bg-black"
                        />
                      )}
                      {d.url ? (
                        <a href={d.url} download className="text-xs underline hover:text-neutral-100">
                          {d.naam}
                        </a>
                      ) : (
                        <span className="text-xs text-neutral-500">{d.naam}</span>
                      )}
                      <span className="ml-2 text-xs text-neutral-600">{Math.round(d.bytes / 1e6)} MB</span>
                      {d.hook_variant && (
                        <span className="ml-2 text-xs text-neutral-500" title={d.hook_tekst ?? undefined}>
                          hookvariant {d.hook_variant}
                        </span>
                      )}
                      {d.keuring_status && (
                        <span
                          className={`ml-2 rounded px-1.5 py-0.5 text-[11px] ${KEURING_TEKST[d.keuring_status].klasse}`}
                          title={d.keuring_fouten?.length ? d.keuring_fouten.join('\n') : undefined}
                        >
                          {KEURING_TEKST[d.keuring_status].label}
                        </span>
                      )}
                      {d.keuring_status === 'review_nodig' && d.keuring_fouten && d.keuring_fouten.length > 0 && (
                        <ul className="ml-4 mt-0.5 list-disc text-[11px] text-amber-300/80">
                          {d.keuring_fouten.map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      )}
                      <RenderFeedback
                        jobId={job.id}
                        bestandNaam={d.naam}
                        beoordeling={d.beoordeling ?? null}
                        gepost={d.gepost ?? null}
                      />
                      {/* Goed genoeg om af te maken: dezelfde montage als Premiere-project met de 4K-bron. */}
                      {d.url && <AfwerkKnop jobId={job.id} bestandNaam={d.naam} />}
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
