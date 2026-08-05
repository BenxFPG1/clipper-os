'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * ClipArmy automatisch laten ophalen zodat de cloud zelf nieuwe campagnes
 * binnenhaalt — ook als je laptop dicht is.
 *
 * Je plakt hier het verzoek dat je eigen browser doet ("Copy as cURL"), niet je
 * wachtwoord. Een wachtwoord geeft volledige toegang tot je account en zou in
 * onze database staan; dit token leest alleen wat jij zelf ook ziet, verloopt
 * vanzelf, en je trekt het in door op ClipArmy uit te loggen.
 */
export function ClipArmySessie({
  ingesteld,
  laatsteCheck,
  laatsteFout,
}: {
  ingesteld: boolean;
  laatsteCheck: string | null;
  laatsteFout: string | null;
}) {
  const router = useRouter();
  const [curl, setCurl] = useState('');
  const [sleutel, setSleutel] = useState('');
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  const site = typeof window !== 'undefined' ? window.location.origin : '';
  // De bladwijzer leest de sessie uit de opslag van je browser. Het
  // vernieuwingstoken staat namelijk nergens in een netwerkverzoek — je kunt het
  // dus niet kopiëren, alleen op de pagina zelf ophalen. En juist dát token is
  // wat het uurlijks ophalen laat werken zonder dat jij er nog iets voor doet.
  const koppelCode = sleutel
    ? `javascript:(async()=>{try{` +
      `let a=null,ref=null;` +
      `for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(!/auth-token/.test(k))continue;` +
      `try{const v=JSON.parse(localStorage.getItem(k));const t=v&&(v.access_token?v:v.currentSession);` +
      `if(t&&t.access_token){a=t;ref=(k.match(/sb-([a-z0-9]+)-auth-token/)||[])[1];}}catch(e){}}` +
      `if(!a)return alert('Geen sessie gevonden. Ben je ingelogd op ClipArmy?');` +
      `let key=null;` +
      `for(const s of document.querySelectorAll('script[src]')){try{const t=await (await fetch(s.src)).text();` +
      `const m=t.match(/eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/g)||[];` +
      `for(const c of m){try{const p=JSON.parse(atob(c.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));` +
      `if(p.role==='anon'){key=c;break;}}catch(e){}}}catch(e){}if(key)break;}` +
      `if(!key)return alert('Publieke sleutel niet gevonden op de pagina.');` +
      `const r=await fetch('${site}/api/platform-sessie/extern',{method:'POST',` +
      `headers:{'content-type':'application/json','x-clipper-sleutel':'${sleutel.replace(/'/g, '')}'},` +
      `body:JSON.stringify({projectUrl:'https://'+ref+'.supabase.co',apikey:key,` +
      `access_token:a.access_token,refresh_token:a.refresh_token})});` +
      `const j=await r.json();alert(r.ok?'Gekoppeld. Clipper OS haalt vanaf nu elk uur zelf nieuwe campagnes op.':'Mislukt: '+(j.error||r.status));` +
      `}catch(e){alert('Mislukt: '+e)}})()`
    : '';

  async function bewaar(waarde: string) {
    setBusy(true);
    setMelding(null);
    const res = await fetch('/api/platform-sessie', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'cliparmy', curl: waarde }),
    });
    const uit = (await res.json()) as { error?: string; verzoek?: string };
    setBusy(false);
    if (!res.ok) {
      setMelding(uit.error ?? 'Opslaan mislukt');
      return;
    }
    setMelding(waarde ? `Bewaard (${uit.verzoek}). De cloud checkt vanaf nu elk uur.` : 'Sessie gewist.');
    setCurl('');
    router.refresh();
  }

  return (
    <details
      open={!ingesteld}
      className={`rounded border p-4 ${ingesteld ? 'border-neutral-800' : 'border-amber-700/60 bg-amber-950/20'}`}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Nieuwe ClipArmy-campagnes automatisch ophalen{' '}
        <span className={ingesteld ? 'text-emerald-400' : 'text-amber-400'}>
          {ingesteld ? '(staat aan)' : '(staat uit — eenmalig instellen)'}
        </span>
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-neutral-400">
          De cloud haalt dan elk uur nieuwe campagnes op: je laptop hoeft niet aan te staan en je hoeft de site
          niet te bezoeken.
        </p>
        <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3">
          <p className="mb-2 text-sm font-medium">Aanbevolen: koppelen met één klik</p>
          <p className="mb-2 text-xs text-neutral-400">
            Een toegangstoken verloopt na ongeveer een uur. Alleen het vernieuwingstoken houdt de koppeling
            in de lucht, en dat staat in geen enkel netwerkverzoek — het is niet te kopiëren, alleen vanaf de
            pagina uit te lezen. Deze bladwijzer doet dat.
          </p>
          <input
            type="password"
            value={sleutel}
            onChange={(e) => setSleutel(e.target.value)}
            placeholder="Clipper OS-wachtwoord"
            className="mb-2 w-56 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs"
          />
          {sleutel && (
            <p className="text-xs text-neutral-400">
              <a
                href={koppelCode}
                onClick={(e) => e.preventDefault()}
                className="mr-3 inline-block cursor-grab rounded bg-neutral-100 px-3 py-1.5 font-medium text-neutral-900"
                title="Sleep mij naar je bladwijzerbalk"
              >
                → ClipArmy koppelen
              </a>
              sleep naar je bladwijzerbalk, ga naar cliparmy.nl en klik hem daar aan
            </p>
          )}
        </div>

        <p className="text-xs text-neutral-500">
          Of handmatig, als de bladwijzer niet lukt: plak het verzoek dat je browser doet. Werkt, maar het
          token daarin verloopt na een uur — dan moet je opnieuw plakken.
        </p>
        <ol className="list-inside list-decimal space-y-1 text-xs text-neutral-400">
          <li>Open de campagnepagina op ClipArmy terwijl je ingelogd bent.</li>
          <li>
            Druk op F12 (of Cmd+Option+I) → tabblad <span className="text-neutral-300">Netwerk</span> → filter{' '}
            <span className="text-neutral-300">Fetch/XHR</span>.
          </li>
          <li>Ververs de pagina. Klik de regels langs tot je er een ziet met de campagnes erin (tab Preview/Respons).</li>
          <li>
            Rechtermuisknop op die regel →{' '}
            <span className="text-neutral-300">Kopiëren → Kopiëren als cURL</span>.
          </li>
          <li>Plak hem hieronder en bewaar.</li>
        </ol>
        <textarea
          value={curl}
          onChange={(e) => setCurl(e.target.value)}
          rows={4}
          placeholder="curl 'https://…/rest/v1/campaigns?select=*' -H 'authorization: Bearer …' …"
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => bewaar(curl)}
            disabled={busy || !curl.trim()}
            className="rounded border border-neutral-700 px-3 py-1.5 disabled:opacity-40"
          >
            {busy ? 'Bezig…' : 'Verzoek bewaren'}
          </button>
          {ingesteld && (
            <button onClick={() => bewaar('')} disabled={busy} className="text-xs text-neutral-500 hover:text-neutral-300">
              sessie wissen
            </button>
          )}
          {melding && <span className="text-neutral-400">{melding}</span>}
        </div>
        {ingesteld && (
          <p className="text-xs text-neutral-500">
            Laatste check: {laatsteCheck ? new Date(laatsteCheck).toLocaleString('nl-NL') : 'nog niet gedraaid'}
            {laatsteFout ? ` — ${laatsteFout}` : ''}
          </p>
        )}
        <p className="text-xs text-neutral-500">
          Het token verloopt vanzelf. Werkt het niet meer, dan zie je dat hierboven staan en plak je een vers
          verzoek.
        </p>
      </div>
    </details>
  );
}
