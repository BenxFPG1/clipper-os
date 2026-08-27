import Link from 'next/link';

export const metadata = {
  title: 'Privacybeleid — Clipper OS',
  description: 'Welke gegevens Clipper OS verwerkt en waarom.',
};

/**
 * Publieke pagina: Google vereist een bereikbaar privacybeleid voordat een
 * OAuth-app gepubliceerd mag worden. Staat daarom buiten de Google-poort
 * (zie PUBLIEKE_ROUTES in middleware.ts).
 *
 * De inhoud beschrijft wat de tool feitelijk doet — geen overgenomen
 * standaardtekst. Een privacybeleid dat niet klopt met de werkelijkheid is
 * erger dan geen.
 */
export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-neutral-200">
      <h1 className="text-3xl font-bold text-white">Privacybeleid</h1>
      <p className="mt-2 text-sm text-neutral-400">Laatst bijgewerkt: 27 augustus 2026</p>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Wat Clipper OS is</h2>
        <p>
          Clipper OS is een interne werktool van Nestors Create voor het maken van korte video&apos;s uit
          langer bronmateriaal. De tool is niet openbaar en wordt gebruikt door een klein, vast team.
          Er is geen registratie voor derden.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Welke persoonsgegevens we verwerken</h2>
        <p>Van de mensen die inloggen verwerken we uitsluitend:</p>
        <ul className="list-inside list-disc space-y-1 text-neutral-300">
          <li>
            <strong>E-mailadres en naam</strong> uit je Google-account, en alleen om vast te stellen wie je
            bent bij het inloggen. We vragen Google geen toegang tot je e-mail, agenda, bestanden of andere
            gegevens.
          </li>
          <li>
            <strong>Inlogmomenten</strong> — het tijdstip van je laatste keer inloggen, om sessies te kunnen
            verlopen.
          </li>
        </ul>
        <p>
          We gebruiken deze gegevens niet voor advertenties, profilering of analyse, en verkopen of delen ze
          niet met derden.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Welke andere gegevens de tool verwerkt</h2>
        <p>
          Naast inloggegevens verwerkt Clipper OS werkmateriaal: bronvideo&apos;s en transcripten, campagne-
          en briefinginformatie, gemonteerde clips, en prestatiecijfers van geplaatste clips. Daarnaast
          verzamelt de tool <strong>openbaar zichtbare</strong> gegevens van sociale-mediaplatforms (zoals
          weergaven en bijschriften van openbare posts) om te leren wat het goed doet. Dat gebeurt alleen met
          publiek toegankelijke informatie.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Waar het staat</h2>
        <ul className="list-inside list-disc space-y-1 text-neutral-300">
          <li><strong>Supabase</strong> — database en accountgegevens</li>
          <li><strong>Cloudflare R2</strong> — opslag van video&apos;s en montagebestanden</li>
          <li><strong>Vercel</strong> — hosting van de applicatie</li>
          <li><strong>Anthropic (Claude)</strong> — verwerkt tekst en beeld voor plannen, scripts en analyses</li>
        </ul>
        <p>
          Deze partijen verwerken gegevens namens ons. Je Google-inloggegevens gaan niet naar deze partijen,
          behalve naar Supabase, dat de inlogsessie beheert.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Hoe lang we het bewaren</h2>
        <p>
          Inloggegevens bewaren we zolang je account actief is. Sessies verlopen automatisch na zeven dagen.
          Werkmateriaal bewaren we zolang het voor het werk nodig is.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Je rechten</h2>
        <p>
          Je kunt op elk moment vragen welke gegevens we van je hebben, ze laten corrigeren of laten
          verwijderen. Omdat het om een klein intern team gaat, gaat dat het snelst door het gewoon te
          vragen. Je kunt je Google-koppeling ook zelf intrekken via je{' '}
          <a
            className="underline hover:text-white"
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
          >
            Google-accountinstellingen
          </a>
          .
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-white">Contact</h2>
        <p>
          Vragen over dit beleid of over je gegevens:{' '}
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
        <Link href="/voorwaarden" className="text-neutral-400 underline hover:text-white">
          Gebruiksvoorwaarden
        </Link>
      </p>
    </div>
  );
}
