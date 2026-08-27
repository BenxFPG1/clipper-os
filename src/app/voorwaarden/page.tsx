import Link from 'next/link';

export const metadata = {
  title: 'Gebruiksvoorwaarden — Clipper OS',
  description: 'De voorwaarden voor het gebruik van Clipper OS.',
};

/**
 * Publieke pagina: Google vereist bereikbare gebruiksvoorwaarden voordat een
 * OAuth-app gepubliceerd mag worden. Staat daarom buiten de Google-poort
 * (zie PUBLIEKE_ROUTES in middleware.ts).
 */
export default function VoorwaardenPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-neutral-200">
      <h1 className="text-3xl font-bold text-white">Gebruiksvoorwaarden</h1>
      <p className="mt-2 text-sm text-neutral-400">Laatst bijgewerkt: 27 augustus 2026</p>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Besloten tool</h2>
        <p>
          Clipper OS is een interne tool van Nestors Create. Toegang is op uitnodiging en beperkt tot leden
          van het team. Er is geen openbare registratie, en je kunt geen account aanvragen.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Toegestaan gebruik</h2>
        <p>
          Je gebruikt de tool voor het werk waarvoor hij bedoeld is: het plannen, monteren en meten van
          clips. Je deelt je toegang niet met anderen en gebruikt de tool niet om materiaal te maken dat in
          strijd is met de regels van de platforms waarop het geplaatst wordt, of met de rechten van
          anderen.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Bronmateriaal en rechten</h2>
        <p>
          Het bronmateriaal dat je in de tool zet blijft van de rechthebbende. Je bent er zelf
          verantwoordelijk voor dat je het materiaal mag gebruiken en bewerken voor de campagne waarvoor je
          het inzet.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Beschikbaarheid</h2>
        <p>
          De tool wordt geleverd zoals hij is. Er is geen garantie op beschikbaarheid: onderdelen leunen op
          externe diensten die kunnen uitvallen, en er kan onderhoud plaatsvinden zonder aankondiging.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Beëindiging</h2>
        <p>
          Toegang kan op elk moment worden ingetrokken, bijvoorbeeld als je niet langer bij het team hoort.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Gegevens</h2>
        <p>
          Hoe we met persoonsgegevens omgaan staat in het{' '}
          <Link href="/privacy" className="underline hover:text-white">
            privacybeleid
          </Link>
          .
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Contact</h2>
        <p>
          Vragen:{' '}
          <a className="underline hover:text-white" href="mailto:zijlstraantonie@gmail.com">
            zijlstraantonie@gmail.com
          </a>
          .
        </p>
      </section>

      <p className="mt-12 text-sm">
        <Link href="/toegang" className="text-neutral-400 underline hover:text-white">
          Terug naar inloggen
        </Link>
        <span className="mx-2 text-neutral-600">·</span>
        <Link href="/privacy" className="text-neutral-400 underline hover:text-white">
          Privacybeleid
        </Link>
      </p>
    </div>
  );
}
