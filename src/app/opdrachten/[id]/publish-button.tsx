'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { roepApiAan } from '@/app/api-aanroep';

export type PublishedClip = {
  id: string;
  status: string;
  post_url: string | null;
};

/**
 * Zet het script om in een clip-rij zodat de video na plaatsing automatisch
 * getrackt wordt en meetelt in de wekelijkse retro. Zodra dat gebeurd is, kun je
 * hier meteen de post-URL kwijt — hetzelfde als bij een geknipte clip.
 */
export function PublishButton({
  briefId,
  clip,
  scriptId,
}: {
  briefId: string;
  clip: PublishedClip | null;
  /** Specifieke variant om te publiceren; zonder pakt de server de nieuwste. */
  scriptId?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);
  const [postUrl, setPostUrl] = useState(clip?.post_url ?? '');

  async function publish() {
    setBusy(true);
    setMelding(null);
    const { ok, json, fout } = await roepApiAan<{ waarschuwing?: string | null }>(`/api/briefs/${briefId}/publish`, {
      method: 'POST',
      body: scriptId ? { scriptId } : {},
    });
    setBusy(false);
    setMelding(ok ? (json.waarschuwing ?? null) : (fout ?? 'Publiceren mislukt'));
    router.refresh();
  }

  // Het antwoord tonen: een afgekeurde status of URL sprong eerder na de
  // refresh stilzwijgend terug.
  async function patch(body: Record<string, unknown>) {
    if (!clip) return;
    setBusy(true);
    setMelding(null);
    const { ok, fout } = await roepApiAan(`/api/clips/${clip.id}`, { method: 'PATCH', body });
    setBusy(false);
    if (!ok) {
      setMelding(fout ?? 'Bijwerken mislukt');
      return;
    }
    router.refresh();
  }

  if (!clip) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={publish}
          disabled={busy}
          className="rounded border border-neutral-700 px-4 py-2 text-sm disabled:opacity-40"
        >
          {busy ? 'Bezig…' : 'Als clip in de tracking zetten'}
        </button>
        <span className="text-sm text-neutral-500">
          Daarna telt deze video mee in de performance en in de wekelijkse retro.
        </span>
        {melding && <p className="w-full text-sm text-red-400">{melding}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 px-4 py-3">
      <span className="text-sm text-neutral-400">In de tracking:</span>

      <select
        value={clip.status}
        disabled={busy}
        onChange={(e) => patch({ status: e.target.value })}
        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
      >
        <option value="planned">gepland</option>
        <option value="edited">gemaakt</option>
        <option value="posted">gepost</option>
        <option value="rejected">afgekeurd</option>
      </select>

      <input
        value={postUrl}
        disabled={busy}
        onChange={(e) => setPostUrl(e.target.value)}
        onBlur={() => postUrl !== (clip.post_url ?? '') && patch({ post_url: postUrl })}
        placeholder="post-URL plakken"
        className="w-72 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
      />

      {melding && <span className="text-sm text-neutral-400">{melding}</span>}
    </div>
  );
}
