'use client';

import { useState } from 'react';

/**
 * De bladwijzer die een ClipArmy-campagnepagina met één klik importeert.
 *
 * Waarom zo en niet automatisch: de campagnes staan achter een login, en een
 * server die met jouw wachtwoord inlogt is een beveiligingsrisico én tegen de
 * voorwaarden van zo'n platform. Met de bookmarklet bezoek jij de pagina zelf
 * (ingelogd in je eigen browser) en stuurt één klik de tekst die jij al ziet
 * naar Clipper OS. Sneller wordt het niet zonder hun medewerking.
 */
export function ClipArmyBookmarklet() {
  const [open, setOpen] = useState(false);
  const [sleutel, setSleutel] = useState('');

  const site = typeof window !== 'undefined' ? window.location.origin : '';
  const code = sleutel
    ? `javascript:(async()=>{try{const r=await fetch('${site}/api/campaigns/import-extern',{method:'POST',headers:{'content-type':'application/json','x-clipper-sleutel':'${sleutel.replace(/'/g, '')}'},body:JSON.stringify({tekst:document.body.innerText.slice(0,20000)})});const j=await r.json();alert(r.ok?('Campagne "'+j.campaign.name+'" staat in Clipper OS'+(j.bronKanalen&&j.bronKanalen.length?' met '+j.bronKanalen.length+' bron(nen)':'')):'Mislukt: '+(j.error||r.status));}catch(e){alert('Mislukt: '+e)}})()`
    : '';

  return (
    <details
      className="rounded border border-neutral-800 p-4"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-sm text-neutral-400">
        Nieuwe ClipArmy-campagne in één klik binnenhalen (bookmarklet)
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <ol className="list-inside list-decimal space-y-1 text-neutral-400">
          <li>Vul hieronder je Clipper OS-wachtwoord in (blijft in de bladwijzer, gaat nergens anders heen).</li>
          <li>Sleep de knop naar je bladwijzerbalk.</li>
          <li>
            Sta je op een campagnepagina van cliparmy.nl, klik de bladwijzer: de campagne wordt geïmporteerd,
            inclusief bronherkenning — en de concepten- en planmolen start vanzelf.
          </li>
        </ol>
        <input
          type="password"
          value={sleutel}
          onChange={(e) => setSleutel(e.target.value)}
          placeholder="Clipper OS-wachtwoord"
          className="w-64 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5"
        />
        {sleutel && (
          <p>
            <a
              href={code}
              onClick={(e) => e.preventDefault()}
              className="inline-block cursor-grab rounded bg-neutral-100 px-4 py-2 font-medium text-neutral-900"
              title="Sleep mij naar je bladwijzerbalk"
            >
              → Clipper OS import
            </a>
            <span className="ml-3 text-xs text-neutral-500">sleep deze knop naar je bladwijzerbalk</span>
          </p>
        )}
        <p className="text-xs text-neutral-500">
          Waarom niet volledig automatisch: de campagnes staan achter een login. Een server die met jouw
          wachtwoord bij ClipArmy inlogt is een risico en tegen hun voorwaarden — dit is de snelste route die
          netjes blijft.
        </p>
      </div>
    </details>
  );
}
