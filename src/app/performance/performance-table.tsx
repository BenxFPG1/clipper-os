'use client';

import { useMemo, useState } from 'react';
import type { PerformanceRow } from './page';

/** Een clip geldt als outlier zodra hij twee keer de eigen mediaan haalt. */
const OUTLIER_THRESHOLD = 2;

export function PerformanceTable({ rows }: { rows: PerformanceRow[] }) {
  const [structure, setStructure] = useState('');
  const [hook, setHook] = useState('');
  const [platform, setPlatform] = useState('');

  const options = useMemo(
    () => ({
      structures: unique(rows.map((r) => r.structure_type)),
      hooks: unique(rows.map((r) => r.hook_type)),
      platforms: unique(rows.map((r) => r.platform)),
    }),
    [rows],
  );

  const filtered = rows.filter(
    (r) =>
      (!structure || r.structure_type === structure) &&
      (!hook || r.hook_type === hook) &&
      (!platform || r.platform === platform),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Filter label="Structuur" value={structure} onChange={setStructure} options={options.structures} />
        <Filter label="Hook" value={hook} onChange={setHook} options={options.hooks} />
        <Filter label="Platform" value={platform} onChange={setPlatform} options={options.platforms} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="py-2 pr-3">Clip</th>
              <th className="py-2 pr-3">Structuur / hook</th>
              <th className="py-2 pr-3">Platform</th>
              <th className="py-2 pr-3 text-right">24u</th>
              <th className="py-2 pr-3 text-right">7d</th>
              <th className="py-2 pr-3 text-right">Velocity</th>
              <th className="py-2 pr-3 text-right">Outlier</th>
              <th className="py-2">Verloop</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-t border-neutral-900">
                <td className="py-2 pr-3">
                  {r.post_url ? (
                    <a href={r.post_url} target="_blank" rel="noreferrer" className="hover:underline">
                      {r.titel_intern ?? 'Clip'}
                    </a>
                  ) : (
                    (r.titel_intern ?? 'Clip')
                  )}
                </td>
                <td className="py-2 pr-3 text-neutral-400">
                  {r.structure_type ?? '—'} / {r.hook_type ?? '—'}
                </td>
                <td className="py-2 pr-3 text-neutral-400">{r.platform ?? '—'}</td>
                <td className="py-2 pr-3 text-right">{fmt(r.views_24h)}</td>
                <td className="py-2 pr-3 text-right">{fmt(r.views_7d)}</td>
                <td className="py-2 pr-3 text-right">{r.velocity_score ?? '—'}</td>
                <td className="py-2 pr-3 text-right">
                  {r.outlier_score !== null && r.outlier_score >= OUTLIER_THRESHOLD ? (
                    <span className="rounded bg-emerald-900/60 px-2 py-0.5 text-emerald-200">{r.outlier_score}</span>
                  ) : (
                    (r.outlier_score ?? '—')
                  )}
                </td>
                <td className="py-2">
                  <Sparkline points={r.history.map((h) => h.views ?? 0)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Views over tijd als inline SVG — genoeg om de curve te zien zonder chart-library. */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="text-neutral-600">—</span>;

  const width = 100;
  const height = 24;
  const max = Math.max(...points, 1);
  const path = points
    .map((v, i) => `${(i / (points.length - 1)) * width},${height - (v / max) * height}`)
    .join(' ');

  return (
    <svg width={width} height={height} className="text-neutral-400" role="img" aria-label="Views over tijd">
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="text-sm">
      <span className="mr-2 text-neutral-400">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
      >
        <option value="">alle</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
}

function fmt(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('nl-NL');
}
