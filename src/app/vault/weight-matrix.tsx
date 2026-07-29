'use client';

import { useState } from 'react';

type Weight = {
  entity: string;
  entity_key: string;
  platform: string;
  theme: string;
  weight: number;
  eigen_n: number;
  eigen_mediaan: number | null;
  extern_n: number;
  extern_mediaan: number | null;
};

const PLATFORMS = ['all', 'tiktok', 'reels', 'shorts'];

/**
 * Toont welke gewichten gelden voor een gekozen platform en thema, en waar ze
 * vandaan komen. "eigen" is onze eigen clip-performance, "extern" wat de scout
 * bij anderen zag; de retro weegt die twee even zwaar.
 */
export function WeightMatrix({
  weights,
  themes,
}: {
  weights: Weight[];
  themes: { slug: string; name: string }[];
}) {
  const [platform, setPlatform] = useState('all');
  const [theme, setTheme] = useState('all');

  const zichtbaar = weights
    .filter((w) => w.platform === platform && w.theme === theme)
    .sort((a, b) => Number(b.weight) - Number(a.weight));

  return (
    <section className="rounded border border-neutral-800 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-medium">Gewichten per platform en thema</h2>
        <div className="flex gap-2">
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm"
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p === 'all' ? 'alle platforms' : p}
              </option>
            ))}
          </select>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm"
          >
            <option value="all">alle thema&apos;s</option>
            {themes.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {zichtbaar.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">
          Nog geen eigen gewichten voor deze combinatie. De tool gebruikt dan automatisch een breder gewicht, tot de
          retro hier genoeg data voor heeft.
        </p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="py-1 pr-3">Type</th>
              <th className="py-1 pr-3">Gewicht</th>
              <th className="py-1 pr-3">Eigen clips</th>
              <th className="py-1">Extern gezien</th>
            </tr>
          </thead>
          <tbody>
            {zichtbaar.map((w) => (
              <tr key={`${w.entity}-${w.entity_key}`} className="border-t border-neutral-900">
                <td className="py-1 pr-3">
                  <span className="font-mono text-xs">{w.entity_key}</span>
                  <span className="ml-2 text-xs text-neutral-600">{w.entity}</span>
                </td>
                <td className="py-1 pr-3 font-medium">{Number(w.weight).toFixed(2)}</td>
                <td className="py-1 pr-3 text-neutral-400">
                  {w.eigen_n > 0 ? `${w.eigen_n}× · mediaan ${Number(w.eigen_mediaan).toFixed(2)}` : '—'}
                </td>
                <td className="py-1 text-neutral-400">
                  {w.extern_n > 0 ? `${w.extern_n}× · mediaan ${Number(w.extern_mediaan).toFixed(2)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
