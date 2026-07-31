'use client';

import { useMemo, useState } from 'react';

type Find = {
  id: string;
  handle: string | null;
  platform: string;
  theme: string | null;
  post_url: string;
  posted_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  outlier_score: number | null;
  views_per_dag: number | null;
  caption: string | null;
  gevonden_via: string | null;
  decoded: {
    hook_type?: string;
    hook_beschrijving?: string;
    structuur?: string;
    waarom_het_werkt?: string;
    overdraagbaar_naar_ons?: boolean;
    bron_match?: {
      video_id?: string;
      video_titel?: string;
      start_seconds?: number;
      end_seconds?: number;
      score?: number;
      fragment?: string;
      geen_treffer?: boolean;
    };
  } | null;
};

/** Vaste filtercombinaties, zodat je niet elke keer schuifjes hoeft te zetten. */
const PRESETS = [
  { naam: 'Alles', score: 0, views: 0, dagen: 0 },
  { naam: 'Sterk (3×+)', score: 3, views: 0, dagen: 0 },
  { naam: 'Uitzonderlijk (5× + 100k)', score: 5, views: 100_000, dagen: 0 },
  { naam: 'Vers (30 dagen)', score: 2, views: 0, dagen: 30 },
];

function formatTijd(seconden: number): string {
  const m = Math.floor(seconden / 60);
  const s = Math.round(seconden % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function OutlierFeed({ finds, themes }: { finds: Find[]; themes: { slug: string; name: string }[] }) {
  const [platform, setPlatform] = useState('alle');
  const [theme, setTheme] = useState('alle');
  const [minScore, setMinScore] = useState(0);
  const [minViews, setMinViews] = useState(0);
  const [dagen, setDagen] = useState(0);
  const [zoek, setZoek] = useState('');
  const [sortering, setSortering] = useState<'score' | 'views' | 'nieuw'>('score');
  const [open, setOpen] = useState<string | null>(null);

  const zichtbaar = useMemo(() => {
    const grens = dagen > 0 ? Date.now() - dagen * 24 * 3600 * 1000 : null;

    return finds
      .filter((f) => platform === 'alle' || f.platform === platform)
      .filter((f) => theme === 'alle' || f.theme === theme)
      .filter((f) => (f.outlier_score ?? 0) >= minScore)
      .filter((f) => (f.views ?? 0) >= minViews)
      .filter((f) => !grens || (f.posted_at ? new Date(f.posted_at).getTime() >= grens : false))
      .filter((f) => {
        if (!zoek.trim()) return true;
        const q = zoek.toLowerCase();
        return (
          (f.caption ?? '').toLowerCase().includes(q) ||
          (f.handle ?? '').toLowerCase().includes(q) ||
          (f.decoded?.hook_type ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (sortering === 'views') return (b.views ?? 0) - (a.views ?? 0);
        if (sortering === 'nieuw') {
          return new Date(b.posted_at ?? 0).getTime() - new Date(a.posted_at ?? 0).getTime();
        }
        return (b.outlier_score ?? 0) - (a.outlier_score ?? 0);
      });
  }, [finds, platform, theme, minScore, minViews, dagen, zoek, sortering]);

  function pasPresetToe(p: (typeof PRESETS)[number]) {
    setMinScore(p.score);
    setMinViews(p.views);
    setDagen(p.dagen);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded border border-neutral-800 p-4">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.naam}
              onClick={() => pasPresetToe(p)}
              className={`rounded-full border px-3 py-1 text-xs ${
                minScore === p.score && minViews === p.views && dagen === p.dagen
                  ? 'border-neutral-300 bg-neutral-100 text-neutral-900'
                  : 'border-neutral-700 text-neutral-300 hover:border-neutral-500'
              }`}
            >
              {p.naam}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="text-neutral-400">Zoek</span>
            <input
              value={zoek}
              onChange={(e) => setZoek(e.target.value)}
              placeholder="caption, account of hook"
              className="mt-1 block w-56 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5"
            />
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">Platform</span>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="mt-1 block rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5"
            >
              <option value="alle">alle</option>
              <option value="tiktok">TikTok</option>
              <option value="reels">Reels</option>
              <option value="shorts">Shorts</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">Thema</span>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              className="mt-1 block rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5"
            >
              <option value="alle">alle</option>
              {themes.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">Sorteer</span>
            <select
              value={sortering}
              onChange={(e) => setSortering(e.target.value as typeof sortering)}
              className="mt-1 block rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5"
            >
              <option value="score">outlier-score</option>
              <option value="views">views</option>
              <option value="nieuw">nieuwste</option>
            </select>
          </label>
          <span className="ml-auto text-sm text-neutral-500">
            {zichtbaar.length} van {finds.length}
          </span>
        </div>
      </div>

      {zichtbaar.length === 0 ? (
        <p className="rounded border border-dashed border-neutral-800 px-4 py-8 text-center text-sm text-neutral-500">
          Niets binnen deze filters.
        </p>
      ) : (
        <div className="space-y-2">
          {zichtbaar.map((f) => (
            <OutlierKaart key={f.id} find={f} open={open === f.id} onToggle={() => setOpen(open === f.id ? null : f.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function OutlierKaart({ find, open, onToggle }: { find: Find; open: boolean; onToggle: () => void }) {
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);
  const [bron, setBron] = useState(find.decoded?.bron_match ?? null);
  const d = find.decoded ?? {};

  /** Zoekt uit welk moment van onze bronvideo's deze clip komt. */
  async function zoekBron() {
    setBusy(true);
    setMelding(null);
    const res = await fetch('/api/outliers/match-source', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ findId: find.id }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMelding(json.error ?? 'Zoeken mislukt');
      return;
    }
    const gevonden = json.resultaten?.[0]?.match;
    setBron(gevonden ?? { geen_treffer: true });
    if (!gevonden) setMelding('Deze clip komt niet uit een van onze bronvideo\'s.');
  }

  /** Maakt een opdracht van deze vondst, zodat de scriptwriter er een script bij schrijft. */
  async function maakOpdracht() {
    setBusy(true);
    setMelding(null);
    const res = await fetch('/api/briefs/from-outlier', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ findId: find.id }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMelding(json.error ?? 'Aanmaken mislukt');
      return;
    }
    window.location.href = `/opdrachten/${json.briefId}`;
  }

  return (
    <article className="rounded border border-neutral-800">
      <button onClick={onToggle} className="flex w-full items-start justify-between gap-4 px-4 py-3 text-left">
        <span className="min-w-0">
          <span className="block truncate font-medium">{find.caption || `@${find.handle}`}</span>
          <span className="mt-0.5 block text-xs text-neutral-500">
            @{find.handle} · {find.platform}
            {find.theme ? ` · ${find.theme}` : ''}
            {find.posted_at ? ` · ${new Date(find.posted_at).toLocaleDateString('nl-NL')}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-right text-sm">
          <span className="block font-semibold text-emerald-300">{find.outlier_score}× mediaan</span>
          <span className="block text-xs text-neutral-500">
            {find.views !== null ? `${find.views.toLocaleString('nl-NL')} views` : `${(find.likes ?? 0).toLocaleString('nl-NL')} likes`}
          </span>
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-neutral-900 px-4 py-3 text-sm">
          {d.hook_beschrijving ? (
            <div>
              <p>
                <span className="text-neutral-500">Hook: </span>
                {d.hook_beschrijving}
                {d.hook_type && <span className="ml-1 font-mono text-xs text-neutral-500">({d.hook_type})</span>}
              </p>
              {d.structuur && (
                <p>
                  <span className="text-neutral-500">Structuur: </span>
                  {d.structuur}
                </p>
              )}
              {d.waarom_het_werkt && <p className="mt-1 text-neutral-400">{d.waarom_het_werkt}</p>}
            </div>
          ) : (
            <p className="text-neutral-500">Nog niet gedecodeerd — dat gebeurt bij de volgende scout-run.</p>
          )}

          {bron && !bron.geen_treffer && (
            <div className="rounded border border-emerald-900/60 bg-emerald-950/30 px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-emerald-400">Geknipt uit onze bronvideo</p>
              <p className="mt-1">
                <span className="font-medium">{bron.video_titel}</span> op{' '}
                <span className="font-mono">
                  {formatTijd(bron.start_seconds ?? 0)}–{formatTijd(bron.end_seconds ?? 0)}
                </span>
                <span className="ml-2 text-xs text-neutral-500">zekerheid {Math.round((bron.score ?? 0) * 100)}%</span>
              </p>
              {bron.fragment && <p className="mt-1 text-xs text-neutral-400">&ldquo;{bron.fragment.slice(0, 200)}…&rdquo;</p>}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <a
              href={find.post_url}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-neutral-700 px-3 py-1.5 text-xs hover:border-neutral-500"
            >
              Bekijk post
            </a>
            <button
              onClick={maakOpdracht}
              disabled={busy}
              className="rounded bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 disabled:opacity-40"
            >
              {busy ? 'Bezig…' : 'Maak hier een script van'}
            </button>
            {(find.platform === 'tiktok' || find.platform === 'shorts') && !bron && (
              <button
                onClick={zoekBron}
                disabled={busy}
                className="rounded border border-neutral-700 px-3 py-1.5 text-xs hover:border-neutral-500 disabled:opacity-40"
              >
                Zoek bronmoment
              </button>
            )}
            {find.gevonden_via && <span className="text-xs text-neutral-600">gevonden via {find.gevonden_via}</span>}
          </div>

          {melding && <p className="text-xs text-red-400">{melding}</p>}
        </div>
      )}
    </article>
  );
}
