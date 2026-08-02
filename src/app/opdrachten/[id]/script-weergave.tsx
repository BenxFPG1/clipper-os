import type { Script } from '@/lib/scriptwriter';

/** De volledige weergave van één scriptvariant: verhaallijn, hook, shotlist, examen. */
export function ScriptWeergave({ script }: { script: Script }) {
  return (
    <div className="space-y-5">
      <div className="rounded border border-neutral-800 p-4">
        <h2 className="text-lg font-medium">Concept</h2>
        <p className="mt-1 text-sm">{script.concept}</p>
        <p className="mt-2 text-sm text-neutral-400">
          Structuur <span className="font-mono">{script.structure_type}</span> · hook{' '}
          <span className="font-mono">{script.hook.type}</span>
          {script.risico === 'check_regels' && (
            <span className="ml-2 rounded bg-amber-900/60 px-2 py-0.5 text-xs text-amber-200">check regels</span>
          )}
        </p>
      </div>

      {script.verhaallijn && (
        <div className="rounded border border-emerald-900/50 bg-emerald-950/20 p-4">
          <h2 className="text-sm uppercase tracking-wide text-emerald-400">Verhaallijn</h2>
          <p className="mt-2 text-sm font-medium">{script.verhaallijn.rode_draad}</p>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div><dt className="inline text-neutral-500">Belofte: </dt><dd className="inline">{script.verhaallijn.belofte}</dd></div>
            <div><dt className="inline text-neutral-500">Open vraag: </dt><dd className="inline">{script.verhaallijn.open_vraag}</dd></div>
            <div>
              <dt className="text-neutral-500">Escalatie:</dt>
              <dd><ol className="mt-1 list-inside list-decimal text-neutral-300">{script.verhaallijn.escalatie.map((e, i) => <li key={i}>{e}</li>)}</ol></dd>
            </div>
            <div><dt className="inline text-neutral-500">Payoff: </dt><dd className="inline">{script.verhaallijn.payoff}</dd></div>
          </dl>
        </div>
      )}

      <div className="rounded border border-neutral-800 p-4">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500">Hook</h2>
        <p className="mt-2 font-medium">{script.hook.tekst_overlay}</p>
        <p className="text-sm text-neutral-300">Gesproken: &ldquo;{script.hook.gesproken}&rdquo;</p>
        <p className="mt-1 text-sm text-neutral-400">{script.hook.waarom}</p>
      </div>

      <div className="rounded border border-neutral-800 p-4">
        <h2 className="mb-3 text-sm uppercase tracking-wide text-neutral-500">Shotlist</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-neutral-500">
              <tr>
                <th className="py-1 pr-3">#</th>
                <th className="py-1 pr-3">Tijd</th>
                <th className="py-1 pr-3">Functie</th>
                <th className="py-1 pr-3">Beeld</th>
                <th className="py-1 pr-3">Gesproken</th>
                <th className="py-1 pr-3">In beeld</th>
                <th className="py-1">Edit</th>
              </tr>
            </thead>
            <tbody>
              {script.shotlist.map((shot) => (
                <tr key={shot.volgorde} className="border-t border-neutral-900 align-top">
                  <td className="py-1 pr-3 text-neutral-500">{shot.volgorde}</td>
                  <td className="whitespace-nowrap py-1 pr-3 font-mono text-xs">
                    {shot.seconde_van}–{shot.seconde_tot}s
                  </td>
                  <td className="py-1 pr-3 text-neutral-400">{shot.functie}</td>
                  <td className="py-1 pr-3">{shot.beeld}</td>
                  <td className="py-1 pr-3">{shot.gesproken_tekst}</td>
                  <td className="py-1 pr-3 text-neutral-400">{shot.tekst_in_beeld ?? '—'}</td>
                  <td className="py-1 text-neutral-400">{shot.edit_notitie}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded border border-neutral-800 p-4">
          <h2 className="text-sm uppercase tracking-wide text-neutral-500">Captions</h2>
          <p className="mt-2 text-sm"><span className="text-neutral-500">TikTok: </span>{script.caption.tiktok}</p>
          <p className="text-sm"><span className="text-neutral-500">Reels: </span>{script.caption.reels}</p>
          <p className="text-sm"><span className="text-neutral-500">Shorts: </span>{script.caption.shorts}</p>
          <p className="mt-2 font-mono text-xs text-neutral-400">{script.hashtags.join(' ')}</p>
        </div>

        <div className="rounded border border-neutral-800 p-4">
          <h2 className="text-sm uppercase tracking-wide text-neutral-500">Nodig om te maken</h2>
          <ul className="mt-2 list-inside list-disc text-sm text-neutral-300">
            {script.benodigdheden.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="rounded border border-neutral-800 p-4">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500">Hook-varianten binnen deze verhaallijn</h2>
        <ul className="mt-2 space-y-1 text-sm text-neutral-300">
          {script.varianten.map((v, i) => (
            <li key={i}>
              <span className="text-neutral-500">{v.aanpak}:</span> &ldquo;{v.hook_tekst}&rdquo; — {v.wijziging}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded border border-neutral-800 p-4">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500">Waarom deze aanpak</h2>
        <p className="mt-2 text-sm text-neutral-300">{script.onderbouwing}</p>
      </div>

      {script.zelfkritiek && (
        <div className="rounded border border-neutral-800 p-4">
          <h2 className="text-sm uppercase tracking-wide text-neutral-500">Zelfexaminatie vóór oplevering</h2>
          <p className="mt-2 text-sm">
            <span className="text-neutral-500">Getoetst als stijl: </span>
            <span className="font-medium">{script.zelfkritiek.stijl}</span>
            <span className="ml-1 text-neutral-400">— {script.zelfkritiek.stijl_oordeel}</span>
          </p>
          <p className="mt-2 text-sm">
            <span className="text-neutral-500">Zwakste punt van het concept: </span>
            {script.zelfkritiek.zwakste_punt}
          </p>
          {script.zelfkritiek.twijfelachtige_keuzes.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-neutral-300">
              {script.zelfkritiek.twijfelachtige_keuzes.map((k, i) => (
                <li key={i}>
                  <span className="text-neutral-500">{k.keuze}: </span>
                  {k.oordeel}
                </li>
              ))}
            </ul>
          )}
          {script.zelfkritiek.verbeterd.length > 0 && (
            <p className="mt-2 text-sm text-neutral-400">Verbeterd: {script.zelfkritiek.verbeterd.join(' · ')}</p>
          )}
        </div>
      )}
    </div>
  );
}
