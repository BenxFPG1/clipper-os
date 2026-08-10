'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Clip, ClipPlan } from '@/lib/planner/schema';

type ClipRow = {
  id: string;
  plan_index: number;
  titel_intern: string | null;
  status: 'planned' | 'edited' | 'posted' | 'rejected';
  post_url: string | null;
  platform: string | null;
  variant_of: string | null;
};

export function PlanEditor({
  plan,
  clips,
  promptVersion,
  planCount,
}: {
  plan: ClipPlan;
  clips: ClipRow[];
  promptVersion: string;
  planCount: number;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-medium">Clip-plan ({plan.clips.length} clips)</h2>
        <span className="text-xs text-neutral-500">
          prompt {promptVersion} · versie {planCount}
        </span>
      </div>

      {plan.clips.map((clip, index) => (
        <ClipCard
          key={index}
          clip={clip}
          row={clips.find((c) => c.plan_index === index && !c.variant_of)}
          variants={clips.filter((c) => c.plan_index === index && c.variant_of)}
        />
      ))}
    </section>
  );
}

function ClipCard({ clip, row, variants }: { clip: Clip; row?: ClipRow; variants: ClipRow[] }) {
  const [open, setOpen] = useState(false);

  async function maakHookVariant(hook: { type: string; tekst_overlay: string }) {
    if (!row) return;
    await fetch(`/api/clips/${row.id}/variant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_type: hook.type, hook_text: hook.tekst_overlay }),
    });
    window.location.reload();
  }

  return (
    <article className="rounded border border-neutral-800">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div>
          <div className="font-medium">
            <span className="mr-2 text-neutral-500">#{clip.prioriteit}</span>
            {clip.titel_intern}
            {clip.score !== undefined && (
              <span className="ml-2 rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
                score {clip.score}/10
              </span>
            )}
          </div>
          <div className="text-sm text-neutral-400">
            {clip.structure_type} · {clip.hook.type} · {clip.verwachte_sterkte}
            {clip.risico === 'check_regels' && (
              <span className="ml-2 rounded bg-amber-900/60 px-2 py-0.5 text-xs text-amber-200">check regels</span>
            )}
          </div>
        </div>
        {row && <ClipControls row={row} />}
      </header>

      <div className="border-t border-neutral-800 px-4 py-3">
        <p className="text-sm">
          <span className="text-neutral-500">Hook-overlay: </span>
          <span className="font-medium">{clip.hook.tekst_overlay}</span>
        </p>
        <p className="text-sm text-neutral-400">Audio start op: &ldquo;{clip.hook.gesproken_start}&rdquo;</p>
        {clip.context_kaart && <p className="mt-1 text-sm text-neutral-400">Contextkaart: {clip.context_kaart}</p>}

        {clip.verhaallijn && (
          <div className="mt-2 space-y-0.5 text-sm text-neutral-400">
            <p>
              <span className="text-neutral-500">Belofte: </span>
              {clip.verhaallijn.belofte}
            </p>
            <p>
              <span className="text-neutral-500">Open vraag: </span>
              {clip.verhaallijn.open_vraag}
            </p>
            <p>
              <span className="text-neutral-500">Payoff: </span>
              {clip.verhaallijn.payoff}
            </p>
          </div>
        )}

        {clip.hooks && clip.hooks.length > 0 && (
          <div className="mt-3">
            <div className="text-xs uppercase tracking-wide text-neutral-500">
              Drie hooks — elk een publiceerbare variant
            </div>
            <ul className="mt-1 space-y-1.5 text-sm">
              {clip.hooks.map((h, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <span className="text-neutral-500">{h.type}:</span>
                  <span>&ldquo;{h.tekst_overlay}&rdquo;</span>
                  {row && h.tekst_overlay !== clip.hook.tekst_overlay && (
                    <button
                      onClick={() => maakHookVariant(h)}
                      className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs text-neutral-300 hover:text-neutral-100"
                    >
                      + als variant posten
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {clip.uitval_risicos && clip.uitval_risicos.length > 0 && (
          <div className="mt-3">
            <div className="text-xs uppercase tracking-wide text-neutral-500">
              Retentie-simulatie: hersteld in het examen
            </div>
            <ul className="mt-1 space-y-1 text-sm text-neutral-400">
              {clip.uitval_risicos.map((u, i) => (
                <li key={i}>
                  <span className="font-mono text-xs text-neutral-500">{formatTime(u.seconde)}</span> {u.waarom} —{' '}
                  <span className="text-neutral-300">{u.fix}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full border-t border-neutral-800 px-4 py-2 text-left text-sm text-neutral-400 hover:text-neutral-100"
      >
        {open ? 'Verberg editscript' : `Toon editscript (${clip.shots.length} shots)`}
      </button>

      {open && (
        <div className="space-y-4 border-t border-neutral-800 px-4 py-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500">
                <tr>
                  <th className="py-1 pr-3">#</th>
                  <th className="py-1 pr-3">Tijd</th>
                  <th className="py-1 pr-3">Functie</th>
                  <th className="py-1 pr-3">Spanning</th>
                  <th className="py-1 pr-3">Fragment</th>
                  <th className="py-1">Edit</th>
                </tr>
              </thead>
              <tbody>
                {clip.shots.map((shot) => (
                  <tr key={shot.volgorde} className="border-t border-neutral-900 align-top">
                    <td className="py-1 pr-3 text-neutral-500">{shot.volgorde}</td>
                    <td className="whitespace-nowrap py-1 pr-3 font-mono text-xs">
                      {formatTime(shot.start)}–{formatTime(shot.end)}
                    </td>
                    <td className="py-1 pr-3 text-neutral-400">{shot.functie}</td>
                    <td className="py-1 pr-3 text-neutral-400">{shot.spanning ?? '—'}</td>
                    <td className="py-1 pr-3">{shot.transcript_fragment}</td>
                    <td className="py-1 text-neutral-400">{shot.edit_notitie}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Caption label="TikTok" text={clip.caption.tiktok} />
            <Caption label="Reels" text={clip.caption.reels} />
            <Caption label="Shorts" text={clip.caption.shorts} />
          </div>

          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">Verplicht in de post</div>
            <ul className="mt-1 list-inside list-disc text-sm text-neutral-300">
              {clip.verplichte_elementen.map((el, i) => (
                <li key={i}>{el}</li>
              ))}
            </ul>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">Varianten</div>
            <ul className="mt-1 space-y-1 text-sm text-neutral-300">
              {clip.varianten.map((v, i) => (
                <li key={i}>
                  <span className="text-neutral-500">{v.aanpak}:</span> &ldquo;{v.hook_tekst}&rdquo; — {v.wijziging}
                </li>
              ))}
            </ul>
          </div>

          <p className="text-sm text-neutral-400">
            <span className="text-neutral-500">Waarom dit werkt: </span>
            {clip.waarom_dit_werkt}
          </p>

          {variants.length > 0 && (
            <div className="text-sm text-neutral-400">
              {variants.length} variant{variants.length === 1 ? '' : 'en'} aangemaakt
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function ClipControls({ row }: { row: ClipRow }) {
  const router = useRouter();
  const [postUrl, setPostUrl] = useState(row.post_url ?? '');
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    await fetch(`/api/clips/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    router.refresh();
  }

  async function createVariant() {
    setBusy(true);
    await fetch(`/api/clips/${row.id}/variant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={row.status}
        disabled={busy}
        onChange={(e) => patch({ status: e.target.value })}
        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
      >
        <option value="planned">gepland</option>
        <option value="edited">geëdit</option>
        <option value="posted">gepost</option>
        <option value="rejected">afgekeurd</option>
      </select>

      <input
        value={postUrl}
        disabled={busy}
        onChange={(e) => setPostUrl(e.target.value)}
        onBlur={() => postUrl !== (row.post_url ?? '') && patch({ post_url: postUrl })}
        placeholder="post-URL plakken"
        className="w-56 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
      />

      <button
        onClick={createVariant}
        disabled={busy}
        className="rounded border border-neutral-700 px-2 py-1 text-sm text-neutral-300 disabled:opacity-40"
      >
        + variant
      </button>
    </div>
  );
}

function Caption({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded border border-neutral-800 p-2">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-sm">{text}</div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
