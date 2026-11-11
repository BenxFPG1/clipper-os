import Link from 'next/link';

export default function NietGevonden() {
  return (
    <div className="mx-auto max-w-xl space-y-3 rounded border border-neutral-800 p-6">
      <h1 className="text-lg font-medium">Deze pagina bestaat niet (meer)</h1>
      <p className="text-sm text-neutral-400">De link klopt niet, of de video of campagne is verwijderd.</p>
      <Link href="/" className="inline-block rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900">
        Naar de startpagina
      </Link>
    </div>
  );
}
