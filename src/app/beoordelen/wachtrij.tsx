'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { roepApiAan } from '@/app/api-aanroep';

type Item = {
  render_job_id: string;
  bestand_naam: string;
  url: string | null;
  hook_variant: number;
  hook_tekst: string | null;
  titel: string;
  job_titel: string | null;
  video_titel: string | null;
  campagne: string | null;
  clip: number | null;
  keuring_status: string | null;
  keuring_fouten: string[];
  klaar_at: string | null;
};

type Oordeel = 'goed' | 'matig' | 'weg';

/** Snelkeuze voor de reden: één tik in plaats van typen op een telefoon. */
const CHIPS = [
  'saaie start',
  'verhaal klopt niet',
  'slecht kader',
  'ondertitels fout',
  'te lang',
  'graphic onleesbaar',
  'geluid',
];

const KEURING: Record<string, { label: string; klasse: string }> = {
  goed: { label: 'keuring goed', klasse: 'bg-emerald-900/60 text-emerald-200' },
  review_nodig: { label: 'review nodig', klasse: 'bg-amber-900/60 text-amber-200' },
  niet_getoetst: { label: 'niet getoetst', klasse: 'bg-neutral-800 text-neutral-400' },
};

const sleutel = (i: Pick<Item, 'render_job_id' | 'bestand_naam'>) => `${i.render_job_id}|${i.bestand_naam}`;

/**
 * Eén render tegelijk, groot in beeld, drie knoppen. Gemaakt om op een
 * telefoon in een paar minuten een stapel renders door te lopen: 'goed' slaat
 * meteen op en gaat door; bij 'matig' of 'weg' eerst (optioneel) een reden via
 * snelkeuze of een paar woorden. Op desktop: 1/2/3 kiest, Enter slaat op,
 * pijltje rechts slaat over.
 */
export function BeoordeelWachtrij() {
  const [items, setItems] = useState<Item[]>([]);
  const [totaal, setTotaal] = useState(0);
  const [start, setStart] = useState<number | null>(null);
  const [gedaan, setGedaan] = useState(0);
  const [overgeslagen, setOvergeslagen] = useState<Set<string>>(new Set());
  const [hookvarianten, setHookvarianten] = useState(false);
  const [laden, setLaden] = useState(true);
  const [fout, setFout] = useState<string | null>(null);

  const [keuze, setKeuze] = useState<Oordeel | null>(null);
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [vrij, setVrij] = useState('');
  const [bezig, setBezig] = useState(false);
  const [gedempt, setGedempt] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  const laad = useCallback(
    async (metVarianten: boolean, reset: boolean) => {
      setLaden(true);
      setFout(null);
      const { ok, json, fout } = await roepApiAan<{ items?: Item[]; totaal?: number }>(
        `/api/beoordelen${metVarianten ? '?hookvarianten=1' : ''}`,
      );
      setLaden(false);
      if (!ok) {
        setFout(fout ?? 'Wachtrij laden mislukt');
        return;
      }
      setItems(json.items ?? []);
      setTotaal(json.totaal ?? 0);
      if (reset) {
        setStart(json.totaal ?? 0);
        setGedaan(0);
        setOvergeslagen(new Set());
        setUitgeput(false);
      }
    },
    [],
  );

  useEffect(() => {
    laad(false, true);
  }, [laad]);

  const zichtbaar = items.filter((i) => !overgeslagen.has(sleutel(i)));
  const huidig = zichtbaar[0] ?? null;
  const volgende = zichtbaar[1] ?? null;

  // Nieuwe clip: keuze leeg, geluid weer uit (autoplay mag alleen gedempt).
  useEffect(() => {
    setKeuze(null);
    setChips(new Set());
    setVrij('');
    setGedempt(true);
  }, [huidig?.render_job_id, huidig?.bestand_naam]);

  const volgendeItem = useCallback((weg: Item) => {
    setItems((lijst) => lijst.filter((i) => sleutel(i) !== sleutel(weg)));
    setTotaal((t) => Math.max(0, t - 1));
  }, []);

  // De geladen stapel is op maar er wacht nog meer: bijladen. Leverde de
  // vorige keer bijladen niets nieuws op (alles overgeslagen), dan stoppen
  // we, anders blijft hij eindeloos laden.
  const [uitgeput, setUitgeput] = useState(false);
  useEffect(() => {
    if (laden || uitgeput || zichtbaar.length > 0 || totaal - overgeslagen.size <= 0) return;
    void (async () => {
      await laad(hookvarianten, false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zichtbaar.length, totaal, overgeslagen.size, laden, uitgeput]);
  useEffect(() => {
    if (!laden && items.length > 0 && zichtbaar.length === 0) setUitgeput(true);
    if (zichtbaar.length > 0) setUitgeput(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laden, items]);

  const bewaar = useCallback(
    async (oordeel: Oordeel) => {
      if (!huidig || bezig) return;
      const reden = [...chips, vrij.trim()].filter(Boolean).join('; ');
      setBezig(true);
      setFout(null);
      const { ok, fout } = await roepApiAan(`/api/renders/${huidig.render_job_id}/beoordeling`, {
        method: 'POST',
        body: { bestand_naam: huidig.bestand_naam, oordeel, ...(reden ? { reden } : {}) },
      });
      setBezig(false);
      if (!ok) {
        setFout(fout ?? 'Opslaan mislukt');
        return;
      }
      setGedaan((n) => n + 1);
      volgendeItem(huidig);
    },
    [huidig, bezig, chips, vrij, volgendeItem],
  );

  const kies = useCallback(
    (oordeel: Oordeel) => {
      if (oordeel === 'goed') void bewaar('goed');
      else setKeuze(oordeel);
    },
    [bewaar],
  );

  const sla = useCallback(() => {
    if (!huidig) return;
    setOvergeslagen((s) => new Set(s).add(sleutel(huidig)));
  }, [huidig]);

  // Sneltoetsen op desktop; niet terwijl je in het tekstveld typt.
  useEffect(() => {
    function toets(e: KeyboardEvent) {
      const doel = e.target as HTMLElement | null;
      if (doel && (doel.tagName === 'INPUT' || doel.tagName === 'TEXTAREA')) {
        if (e.key === 'Enter' && keuze) void bewaar(keuze);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '1') kies('goed');
      else if (e.key === '2') kies('matig');
      else if (e.key === '3') kies('weg');
      else if (e.key === 'Enter' && keuze) void bewaar(keuze);
      else if (e.key === 'ArrowRight') sla();
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', toets);
    return () => window.removeEventListener('keydown', toets);
  }, [kies, bewaar, sla, keuze]);

  function wisselGeluid() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setGedempt(v.muted);
    if (v.paused) void v.play().catch(() => undefined);
  }

  const positie = gedaan + overgeslagen.size + 1;
  const totaalStart = start ?? totaal;

  return (
    <div className="mx-auto max-w-md space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Beoordelen</h1>
        <label className="flex min-h-[36px] items-center gap-2 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={hookvarianten}
            onChange={(e) => {
              setHookvarianten(e.target.checked);
              void laad(e.target.checked, true);
            }}
            className="h-4 w-4"
          />
          ook hookvarianten
        </label>
      </div>

      {laden && items.length === 0 ? (
        <p className="text-sm text-neutral-500">Wachtrij laden…</p>
      ) : !huidig ? (
        <div className="space-y-3 rounded border border-dashed border-neutral-800 px-4 py-8 text-center text-sm text-neutral-400">
          <p>
            {gedaan > 0 ? `Klaar — ${gedaan} beoordeeld. ` : ''}
            {overgeslagen.size > 0
              ? `${overgeslagen.size} overgeslagen; die staan er de volgende keer weer.`
              : 'Niets meer te beoordelen.'}
          </p>
          {overgeslagen.size > 0 && (
            <button
              type="button"
              onClick={() => setOvergeslagen(new Set())}
              className="min-h-[44px] rounded border border-neutral-700 px-4 py-2"
            >
              Overgeslagen nog eens bekijken
            </button>
          )}
          <p>
            <Link href="/" className="underline">
              Terug naar het dashboard
            </Link>
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-neutral-500">
            <span>
              {Math.min(positie, Math.max(totaalStart, positie))} van {Math.max(totaalStart, positie)}
            </span>
            <button type="button" onClick={sla} className="min-h-[36px] px-2 underline hover:text-neutral-200">
              overslaan →
            </button>
          </div>

          <div className="relative mx-auto aspect-[9/16] max-h-[68vh] overflow-hidden rounded bg-black">
            {huidig.url ? (
              <video
                key={sleutel(huidig)}
                ref={videoRef}
                src={huidig.url}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                onClick={wisselGeluid}
                className="h-full w-full object-contain"
              />
            ) : (
              <p className="p-4 text-sm text-red-400">Geen afspeellink (bestand ontbreekt in de opslag).</p>
            )}
            {huidig.url && (
              <button
                type="button"
                onClick={wisselGeluid}
                className="absolute bottom-2 right-2 rounded bg-black/70 px-3 py-1.5 text-xs text-neutral-100"
              >
                {gedempt ? 'tik voor geluid' : 'geluid uit'}
              </button>
            )}
          </div>
          {/* Alvast inladen, zodat de volgende direct speelt. */}
          {volgende?.url && <video src={volgende.url} preload="auto" muted playsInline className="hidden" />}

          <div className="space-y-1 text-sm">
            <div className="font-medium">
              {huidig.clip ? `Clip ${huidig.clip}: ` : ''}
              {huidig.titel}
              {huidig.hook_variant > 1 && <span className="ml-2 text-xs text-neutral-500">hookvariant {huidig.hook_variant}</span>}
            </div>
            <div className="text-xs text-neutral-500">
              {[huidig.campagne, huidig.video_titel, huidig.job_titel].filter(Boolean).join(' · ')}
            </div>
            {huidig.keuring_status && KEURING[huidig.keuring_status] && (
              <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${KEURING[huidig.keuring_status].klasse}`}>
                {KEURING[huidig.keuring_status].label}
              </span>
            )}
            {huidig.keuring_fouten.length > 0 && (
              <ul className="list-disc pl-4 text-[11px] text-amber-300/80">
                {huidig.keuring_fouten.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['goed', 'Goed', '1', 'border-emerald-500 bg-emerald-900/60 text-emerald-100'],
                ['matig', 'Matig', '2', 'border-amber-500 bg-amber-900/60 text-amber-100'],
                ['weg', 'Weg', '3', 'border-red-500 bg-red-900/60 text-red-100'],
              ] as const
            ).map(([oordeel, label, toets, aan]) => (
              <button
                key={oordeel}
                type="button"
                disabled={bezig}
                onClick={() => kies(oordeel)}
                className={`min-h-[56px] rounded border text-base font-medium transition-colors disabled:opacity-60 ${
                  keuze === oordeel ? aan : 'border-neutral-700 text-neutral-200 hover:border-neutral-500'
                }`}
              >
                {label}
                <span className="ml-1 hidden text-xs text-neutral-500 sm:inline">{toets}</span>
              </button>
            ))}
          </div>

          {keuze && (
            <div className="space-y-2 rounded border border-neutral-800 p-3">
              <p className="text-xs text-neutral-400">Waarom {keuze}? (optioneel)</p>
              <div className="flex flex-wrap gap-2">
                {CHIPS.map((c) => {
                  const aan = chips.has(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() =>
                        setChips((s) => {
                          const n = new Set(s);
                          if (aan) n.delete(c);
                          else n.add(c);
                          return n;
                        })
                      }
                      className={`min-h-[40px] rounded-full border px-3 text-sm ${
                        aan ? 'border-neutral-200 bg-neutral-100 text-neutral-900' : 'border-neutral-700 text-neutral-300'
                      }`}
                      aria-pressed={aan}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
              <input
                value={vrij}
                onChange={(e) => setVrij(e.target.value)}
                maxLength={300}
                placeholder="of in een paar woorden…"
                className="min-h-[44px] w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => bewaar(keuze)}
                disabled={bezig}
                className="min-h-[52px] w-full rounded bg-neutral-100 text-base font-medium text-neutral-900 disabled:opacity-40"
              >
                {bezig ? 'Bezig…' : 'Opslaan en volgende'}
              </button>
            </div>
          )}

          {fout && <p className="text-sm text-red-400">{fout}</p>}
          <p className="hidden text-xs text-neutral-600 sm:block">Sneltoetsen: 1 goed · 2 matig · 3 weg · Enter opslaan · → overslaan</p>
        </>
      )}
      {!huidig && fout && <p className="text-sm text-red-400">{fout}</p>}
    </div>
  );
}
