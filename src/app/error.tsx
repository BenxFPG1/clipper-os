'use client';

/** Vangt een fout op een pagina op, zodat je niet op de kale foutpagina van Next belandt. */
export default function Fout({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl space-y-3 rounded border border-red-900/60 bg-red-950/20 p-6">
      <h1 className="text-lg font-medium text-red-200">Deze pagina kon niet geladen worden</h1>
      <p className="text-sm text-neutral-300">
        Meestal is dat tijdelijk: de database reageerde niet op tijd. Probeer het opnieuw; blijft het zo, dan staat
        hieronder wat er misging.
      </p>
      <p className="break-words rounded bg-neutral-950/60 px-3 py-2 text-xs text-neutral-400">{error.message || 'Onbekende fout'}</p>
      <button onClick={reset} className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900">
        Opnieuw proberen
      </button>
    </div>
  );
}
