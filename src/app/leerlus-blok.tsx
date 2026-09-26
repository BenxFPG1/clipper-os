import Link from 'next/link';
import type { LeerlusStatus } from '@/lib/status';
import { datumTijd } from '@/lib/format';
import { EvalKnop } from './eval-knop';

const BRON_UITLEG: Record<LeerlusStatus['doelen']['bron'], { label: string; klasse: string }> = {
  standaard: { label: 'standaard — nog niets geleerd', klasse: 'bg-neutral-800 text-neutral-400' },
  extern: { label: 'extern gemeten', klasse: 'bg-sky-900/60 text-sky-200' },
  eigen: { label: 'eigen metingen', klasse: 'bg-emerald-900/60 text-emerald-200' },
  mix: { label: 'extern + eigen', klasse: 'bg-emerald-900/60 text-emerald-200' },
};

const DOEL_LABELS: [keyof Omit<LeerlusStatus['doelen'], 'bron' | 'n'>, string, string][] = [
  ['eersteKnipMaxS', 'eerste knip vóór', 's'],
  ['knippenPer10s', 'knippen per 10 s', ''],
  ['maxSecondenZonderVisueleVerandering', 'max zonder beeldwissel', 's'],
  ['maxSecondenZonderTekst', 'max zonder tekst', 's'],
  ['maxPauzeS', 'max pauze', 's'],
  ['tekstInBeeldAandeel', 'tekst in beeld', '%'],
  ['wisselsEerste3sMin', 'wissels in eerste 3 s (min)', ''],
  ['spraakStartMaxS', 'spraak begint vóór', 's'],
];

/**
 * Leert de tool echt? De keten render → oordeel → gepost → gemeten, wat er in
 * de inbox wacht, de laatste lessen en waar de edit-doelen op steunen. Staat
 * alles op nul of 'standaard', dan is dat precies wat je hier moet zien.
 */
export function LeerlusBlok({ status }: { status: LeerlusStatus }) {
  const { doelen } = status;
  const bron = BRON_UITLEG[doelen.bron] ?? BRON_UITLEG.standaard;
  return (
    <section className="space-y-4 rounded border border-neutral-800 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">Leerlus</h2>
        <span className="text-xs text-neutral-500">
          {status.laatsteSmaakRun ? `smaak-agent laatst: ${datumTijd(status.laatsteSmaakRun)}` : 'smaak-agent nog niet gedraaid'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Getal label="Renders" waarde={status.renders} />
        <Getal
          label="Beoordeeld"
          waarde={status.beoordeeld}
          sub={`${status.perOordeel.goed} goed · ${status.perOordeel.matig} matig · ${status.perOordeel.weg} weg`}
        />
        <Getal label="Gepost" waarde={status.gepost} sub="vanuit een render" />
        <Getal label="Gemeten" waarde={status.gemetenDezeWeek} sub="deze week" />
      </div>

      {status.openRetroVoorstellen > 0 ? (
        <Link href="/inbox" className="block rounded border border-amber-900/60 px-3 py-2 text-sm text-amber-300 hover:border-amber-700">
          {status.openRetroVoorstellen} retro-voorstel{status.openRetroVoorstellen === 1 ? '' : 'len'} wacht
          {status.openRetroVoorstellen === 1 ? '' : 'en'} op je beslissing →
        </Link>
      ) : (
        <p className="text-sm text-neutral-500">
          Geen openstaande retro-voorstellen. <Link href="/inbox" className="underline">Inbox</Link>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm uppercase tracking-wide text-neutral-500">Laatst geleerd</h3>
          {status.lessen.length === 0 ? (
            <p className="text-sm text-neutral-500">Nog niets.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {status.lessen.map((l) => (
                <li key={`${l.titel}-${l.created_at}`}>
                  <span className="text-neutral-200">{l.titel}</span>
                  <span className="block text-xs text-neutral-500">
                    {l.categorie} · {l.bron ?? 'onbekende bron'} · {datumTijd(l.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/vault" className="mt-2 inline-block text-xs text-neutral-400 underline">
            Alle kennis in de vault
          </Link>
        </div>

        <div>
          <h3 className="mb-2 flex flex-wrap items-center gap-2 text-sm uppercase tracking-wide text-neutral-500">
            Edit-doelen
            <span className={`rounded px-1.5 py-0.5 text-[11px] normal-case tracking-normal ${bron.klasse}`}>
              {bron.label}
              {doelen.n > 0 ? ` · n=${doelen.n}` : ''}
            </span>
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {DOEL_LABELS.map(([sleutel, label, eenheid]) => (
              <div key={sleutel} className="contents">
                <dt className="text-neutral-400">{label}</dt>
                <dd className="text-right tabular-nums">
                  {eenheid === '%'
                    ? `${Math.round(doelen[sleutel] * 100)}%`
                    : `${Math.round(doelen[sleutel] * 100) / 100}${eenheid ? ` ${eenheid}` : ''}`}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {status.evalCases > 0 && <EvalKnop aantal={status.evalCases} />}
    </section>
  );
}

function Getal({ label, waarde, sub }: { label: string; waarde: number; sub?: string }) {
  return (
    <div className="rounded border border-neutral-800 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{waarde.toLocaleString('nl-NL')}</div>
      {sub && <div className="text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}
