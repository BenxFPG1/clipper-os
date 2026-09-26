'use client';

import { useState } from 'react';
import { roepApiAan } from '@/app/api-aanroep';

export type Oordeel = 'goed' | 'matig' | 'weg';

export type Beoordeling = {
  oordeel: Oordeel;
  reden: string | null;
  eval_case: boolean;
  beoordeeld_door: string | null;
} | null;

export type Gepost = {
  clip_id: string;
  post_url: string;
  platform: string | null;
  posted_at: string | null;
  views_24h: number | null;
  views_7d: number | null;
} | null;

const KNOPPEN: { oordeel: Oordeel; label: string; aan: string }[] = [
  { oordeel: 'goed', label: 'Goed', aan: 'border-emerald-500 bg-emerald-900/60 text-emerald-100' },
  { oordeel: 'matig', label: 'Matig', aan: 'border-amber-500 bg-amber-900/60 text-amber-100' },
  { oordeel: 'weg', label: 'Weg', aan: 'border-red-500 bg-red-900/60 text-red-100' },
];

const PLATFORM_NAAM: Record<string, string> = { tiktok: 'TikTok', reels: 'Reels', shorts: 'Shorts' };

/**
 * Het oordeel over één gerenderd bestand plus de post-link. Grote knoppen,
 * want dit wordt ook op een telefoon gedaan. Elke klik slaat meteen op; bij
 * 'matig' en 'weg' vragen we één zin waarom, want juist die reden maakt er een
 * les van in plaats van een losse duim.
 *
 * De staat leeft hier lokaal: het paneel ververst elke 20 seconden, en een
 * half getypte reden mag daardoor niet verdwijnen.
 */
export function RenderFeedback({
  jobId,
  bestandNaam,
  beoordeling,
  gepost,
}: {
  jobId: string;
  bestandNaam: string;
  beoordeling: Beoordeling;
  gepost: Gepost;
}) {
  const [oordeel, setOordeel] = useState<Oordeel | null>(beoordeling?.oordeel ?? null);
  const [reden, setReden] = useState(beoordeling?.reden ?? '');
  const [bewaardeReden, setBewaardeReden] = useState(beoordeling?.reden ?? '');
  const [evalCase, setEvalCase] = useState(beoordeling?.eval_case ?? false);
  const [postUrl, setPostUrl] = useState('');
  const [post, setPost] = useState<Gepost>(gepost);
  const [bezig, setBezig] = useState(false);
  const [melding, setMelding] = useState<{ tekst: string; fout: boolean } | null>(null);

  // Nieuwe cijfers van de tracking komen via het paneel binnen; de link zelf
  // houden we lokaal zodra hij hier geplakt is.
  const toonPost = post && gepost && gepost.post_url === post.post_url ? gepost : post;

  async function bewaar(velden: { oordeel?: Oordeel; reden?: string; eval_case?: boolean }) {
    setBezig(true);
    setMelding(null);
    const { ok, fout } = await roepApiAan(`/api/renders/${jobId}/beoordeling`, {
      method: 'POST',
      body: { bestand_naam: bestandNaam, ...velden },
    });
    setBezig(false);
    if (!ok) {
      setMelding({ tekst: fout ?? 'Opslaan mislukt', fout: true });
      return false;
    }
    setMelding({ tekst: 'Bewaard', fout: false });
    return true;
  }

  async function kies(nieuw: Oordeel) {
    const vorige = oordeel;
    setOordeel(nieuw);
    const gelukt = await bewaar({ oordeel: nieuw, reden, eval_case: evalCase });
    if (!gelukt) setOordeel(vorige);
    else setBewaardeReden(reden);
  }

  async function bewaarReden() {
    if (!oordeel || reden === bewaardeReden) return;
    if (await bewaar({ reden })) setBewaardeReden(reden);
  }

  async function wisselEval(aan: boolean) {
    setEvalCase(aan);
    if (!oordeel) return; // gaat mee met het eerste oordeel
    if (!(await bewaar({ eval_case: aan }))) setEvalCase(!aan);
  }

  async function markeerGepost() {
    if (!postUrl.trim()) return;
    setBezig(true);
    setMelding(null);
    const { ok, json, fout } = await roepApiAan<{
      clip?: { id: string; post_url: string; platform: string | null; posted_at: string | null };
    }>(`/api/renders/${jobId}/gepost`, { method: 'POST', body: { bestand_naam: bestandNaam, post_url: postUrl } });
    setBezig(false);
    if (!ok || !json.clip) {
      setMelding({ tekst: fout ?? 'Koppelen mislukt', fout: true });
      return;
    }
    setPost({
      clip_id: json.clip.id,
      post_url: json.clip.post_url,
      platform: json.clip.platform,
      posted_at: json.clip.posted_at,
      views_24h: null,
      views_7d: null,
    });
    setPostUrl('');
    setMelding({ tekst: 'Gekoppeld — de tracking meet hem vanaf nu vanzelf.', fout: false });
  }

  const vraagReden = oordeel === 'matig' || oordeel === 'weg';

  return (
    <div className="mt-2 space-y-2 rounded border border-neutral-800/80 bg-neutral-950/40 p-2">
      <div className="grid grid-cols-3 gap-2">
        {KNOPPEN.map((k) => (
          <button
            key={k.oordeel}
            type="button"
            disabled={bezig}
            onClick={() => kies(k.oordeel)}
            className={`min-h-[44px] rounded border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-60 ${
              oordeel === k.oordeel ? k.aan : 'border-neutral-700 text-neutral-300 hover:border-neutral-500'
            }`}
            aria-pressed={oordeel === k.oordeel}
          >
            {k.label}
          </button>
        ))}
      </div>

      {(vraagReden || (oordeel === 'goed' && reden)) && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={reden}
            onChange={(e) => setReden(e.target.value)}
            onBlur={bewaarReden}
            onKeyDown={(e) => {
              if (e.key === 'Enter') bewaarReden();
            }}
            maxLength={500}
            placeholder={oordeel === 'weg' ? 'Waarom weg? (één zin)' : 'Wat mist er? (één zin)'}
            className="min-h-[44px] flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          />
          {reden !== bewaardeReden && (
            <button
              type="button"
              onClick={bewaarReden}
              disabled={bezig}
              className="min-h-[44px] rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
            >
              Bewaar reden
            </button>
          )}
        </div>
      )}

      <label className="flex min-h-[32px] items-center gap-2 text-xs text-neutral-400">
        <input
          type="checkbox"
          checked={evalCase}
          onChange={(e) => wisselEval(e.target.checked)}
          disabled={bezig}
          className="h-4 w-4"
        />
        in eval-set
        <span className="text-neutral-600">(optioneel: vaste referentieclip om latere versies tegen te toetsen)</span>
      </label>

      {toonPost ? (
        <div className="text-xs text-neutral-400">
          <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-sky-200">
            gepost{toonPost.platform ? ` · ${PLATFORM_NAAM[toonPost.platform] ?? toonPost.platform}` : ''}
          </span>{' '}
          <a href={toonPost.post_url} target="_blank" rel="noreferrer" className="break-all underline hover:text-neutral-200">
            {toonPost.post_url}
          </a>
          <div className="mt-1">
            {toonPost.views_24h !== null || toonPost.views_7d !== null ? (
              <>
                views 24u: <span className="text-neutral-200">{toonPost.views_24h?.toLocaleString('nl-NL') ?? '—'}</span>
                {' · '}7d: <span className="text-neutral-200">{toonPost.views_7d?.toLocaleString('nl-NL') ?? '—'}</span>
              </>
            ) : (
              <span className="text-neutral-500">nog geen cijfers — de tracking meet 4× per dag</span>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={postUrl}
            onChange={(e) => setPostUrl(e.target.value)}
            inputMode="url"
            placeholder="Gepost? Plak de link (TikTok, Instagram, YouTube)"
            className="min-h-[44px] flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={markeerGepost}
            disabled={bezig || !postUrl.trim()}
            className="min-h-[44px] rounded border border-neutral-600 px-4 py-2 text-sm disabled:opacity-40"
          >
            Gepost
          </button>
        </div>
      )}

      {melding && <p className={`text-xs ${melding.fout ? 'text-red-400' : 'text-neutral-500'}`}>{melding.tekst}</p>}
    </div>
  );
}
