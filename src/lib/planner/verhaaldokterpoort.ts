import type { Clip, ClipPlan } from './schema';

/**
 * De mechanische kant van de verhaaldokter: geen oordeel, wel meetbare
 * signalen die de LLM-pas moet naar aanleiding daarvan checken. Dezelfde les
 * als bij de montage- en scriptpoort — een taalmodel oordeelt goed over
 * verhaal maar laat meetbare patronen door omdat ze er "goed uitzien". Een
 * "omslag" die woord-voor-woord de "payoff" herhaalt ziet er in de output
 * prima uit; alleen een woordvergelijking ziet dat het geen echte wending
 * beschrijft, maar een parafrase van de uitkomst.
 *
 * Bewust signalen, geen harde fouten: n-gram-overlap is een ruwe maat, en een
 * omslag mag best dicht bij de payoff liggen als de wending zelf klopt. Het
 * rapport is een aanwijzing waar de verhaaldokter moet kijken, geen
 * blokkade.
 */

export type VerhaaldokterSignaal = {
  clipIndex: number;
  titel: string;
  signaal: string;
};

export type VerhaaldokterRapport = {
  signalen: VerhaaldokterSignaal[];
};

/** Frasen die stakes benoemen zonder ze concreet te maken. */
const VAGE_STAKES = ['belangrijk', 'interessant', 'bijzonder', 'opvallend', 'de moeite waard', 'best wel wat'];

const woordenVan = (t: string): Set<string> =>
  new Set(
    t
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter((w) => w.length > 3),
  );

/** Fractie van de woorden in `a` die ook in `b` voorkomen. */
function overlap(a: string, b: string): number {
  const wa = woordenVan(a);
  const wb = woordenVan(b);
  if (wa.size === 0) return 0;
  let gedeeld = 0;
  for (const w of wa) if (wb.has(w)) gedeeld++;
  return gedeeld / wa.size;
}

export function keurVerhaaldokter(plan: ClipPlan, context: { campagneNaam?: string | null } = {}): VerhaaldokterRapport {
  const signalen: VerhaaldokterSignaal[] = [];
  plan.clips.forEach((clip, i) => {
    for (const signaal of keurUitvoerbaarheid(clip)) signalen.push({ clipIndex: i, titel: clip.titel_intern, signaal });
    for (const signaal of keurMerkveiligheid(clip, context.campagneNaam)) signalen.push({ clipIndex: i, titel: clip.titel_intern, signaal });
  });

  plan.clips.forEach((clip, i) => {
    const { belofte, payoff, omslag } = clip.verhaallijn;

    const payoffOverlap = overlap(omslag, payoff);
    if (payoffOverlap > 0.6) {
      signalen.push({
        clipIndex: i,
        titel: clip.titel_intern,
        signaal: `"omslag" overlapt sterk met "payoff" (${Math.round(payoffOverlap * 100)}% van de woorden) — beschrijft dit echt wat de kijker vlak vóór de payoff dacht, of is het een parafrase van de uitkomst zelf?`,
      });
    }

    const vaag = VAGE_STAKES.filter((w) => belofte.toLowerCase().includes(w) || omslag.toLowerCase().includes(w));
    if (vaag.length > 0) {
      signalen.push({
        clipIndex: i,
        titel: clip.titel_intern,
        signaal: `vage stakes-taal ("${vaag.join('", "')}") in plaats van een concreet belang — geld, geloofwaardigheid, een relatie, een overtuiging?`,
      });
    }
  });

  // Cross-clip: twee clips met (bijna) dezelfde omslag zijn één format twee
  // keer verteld, geen twee verhalen.
  for (let i = 0; i < plan.clips.length; i++) {
    for (let j = i + 1; j < plan.clips.length; j++) {
      const gedeeld = overlap(plan.clips[i].verhaallijn.omslag, plan.clips[j].verhaallijn.omslag);
      if (gedeeld > 0.5) {
        signalen.push({
          clipIndex: i,
          titel: plan.clips[i].titel_intern,
          signaal: `omslag lijkt sterk op clip "${plan.clips[j].titel_intern}" (${Math.round(gedeeld * 100)}% van de woorden) — een echt andere wending, of hetzelfde patroon twee keer?`,
        });
      }
    }
  }

  return { signalen };
}

// ------------------------------------------------------------ uitvoerbaarheid

const STOP = new Set([
  'omdat', 'terwijl', 'waarom', 'wanneer', 'waarna', 'daarna', 'eigenlijk', 'gewoon', 'hebben', 'worden', 'zullen', 'kunnen',
  'moeten', 'zeggen', 'zegt', 'blijkt', 'kijker', 'clip', 'eerst', 'daarom', 'alleen', 'echter', 'niets', 'iemand', 'iedereen',
  'waarin', 'waarop', 'welke', 'zonder', 'tussen', 'tegen', 'onder', 'boven', 'achter', 'volgens', 'verder', 'terug',
]);
const inhoudsWoorden = (t: string): string[] =>
  t
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length >= 5 && !STOP.has(w) && !/^\d+$/.test(w));
/** Getallen genormaliseerd: "2.920", "2920" en "2,920" zijn hetzelfde getal; "−39%" wordt "39". */
const getallen = (t: string): string[] => (t.match(/\d[\d.,]*/g) ?? []).map((g) => g.replace(/[.,]/g, '')).filter((g) => g.length >= 2);

/** Wat de kijker hoort: de letterlijke transcriptfragmenten van de shots. */
export function gesprokenTekst(clip: Pick<Clip, 'shots'>, alleen?: (functie: string) => boolean): string {
  return clip.shots.filter((s) => !alleen || alleen(s.functie)).map((s) => s.transcript_fragment ?? '').join(' ');
}

/** Wat de kijker leest: hook, contextkaart, plankaarten en aangehaalde uitvalrisico-regels. */
export function renderbareTekst(clip: Clip): string {
  const aangehaald = (clip.uitval_risicos ?? [])
    .map((r) => r.fix.match(/["“„]([^"”“]{3,48})["”]/)?.[1])
    .filter((x): x is string => Boolean(x));
  return [clip.hook?.tekst_overlay, clip.context_kaart, ...(clip.kaarten ?? []).map((k) => k.tekst), ...aangehaald]
    .filter(Boolean)
    .join(' ');
}

const deelOvereen = (woorden: string[], tekst: string): number => {
  if (woorden.length === 0) return 1;
  const doel = new Set(inhoudsWoorden(tekst));
  // Stamvergelijking op de eerste zes letters: "januaripiek" en "piek" niet,
  // maar "verloren" en "verloor" wel ongeveer — grof, en daarom een signaal.
  const stammen = new Set([...doel].map((w) => w.slice(0, 6)));
  return woorden.filter((w) => doel.has(w) || stammen.has(w.slice(0, 6))).length / woorden.length;
};

/**
 * Kan de kijker de verhaalboog volgen met alleen wat de renderer maakt —
 * gesproken audio (plus ondertitels), de hook-overlay, de contextkaart, de
 * plankaarten en aangehaalde uitvalrisico-regels? Een boog die hangt aan een
 * "rekenkaart" in edit_notitie bestaat voor de kijker niet: de clip herhaalde
 * dan de fout zonder hem aan te wijzen. Signalen, geen oordeel.
 */
export function keurUitvoerbaarheid(clip: Clip): string[] {
  const uit: string[] = [];
  const gesproken = gesprokenTekst(clip);
  const inBeeld = renderbareTekst(clip);
  const alles = `${gesproken} ${inBeeld}`;
  const payoffShots = clip.shots.filter((s) => s.functie === 'payoff');
  const payoffDuur = payoffShots.reduce((t, s) => t + Math.max(0, s.end - s.start), 0);
  if (payoffShots.length === 0) uit.push('geen payoff-shot: waar hoort de kijker het antwoord op de open vraag?');
  else if (payoffDuur < 3) {
    uit.push(`payoff-shot(s) duren samen ${payoffDuur.toFixed(1)} s — minder dan ~3 s spraak om de open vraag te beantwoorden`);
  }

  const { belofte, open_vraag, payoff, omslag } = clip.verhaallijn;
  const ontbrekend = [...new Set([...getallen(payoff), ...getallen(omslag)])].filter((g) => !getallen(alles).includes(g));
  if (ontbrekend.length) {
    uit.push(`cijfer(s) ${ontbrekend.join(', ')} uit payoff/omslag zijn niet te horen en staan op geen renderbare kaart — de kijker krijgt ze nooit`);
  }
  if (payoffShots.length && deelOvereen(inhoudsWoorden(payoff), `${gesprokenTekst(clip, (f) => f === 'payoff')} ${inBeeld}`) < 0.2) {
    uit.push('de payoff uit de verhaallijn is nauwelijks terug te horen in de payoff-shots — hangt hij aan iets wat niet gerenderd wordt?');
  }
  if (deelOvereen(inhoudsWoorden(`${belofte} ${open_vraag}`), alles) < 0.15) {
    uit.push('belofte/open vraag komen niet terug in wat er klinkt of in beeld staat — de kijker weet niet waar hij op wacht');
  }

  // Kaarten die alleen in edit_notitie of een uitvalrisico-fix zonder
  // aanhalingstekens staan: die tekent de renderer niet.
  const getekend = inBeeld.toLowerCase();
  for (const shot of clip.shots) {
    const notitie = shot.edit_notitie ?? '';
    if (!/kaart|in beeld|overlay|rekensom|tekst op/i.test(notitie)) continue;
    const citaat = notitie.match(/["“„']([^"”“']{3,80})["”']/)?.[1];
    if (citaat && !getekend.includes(citaat.toLowerCase().slice(0, 20))) {
      uit.push(`edit_notitie van shot ${shot.volgorde} vraagt een kaart ("${citaat.slice(0, 50)}") die niet getekend wordt — zet hem in "kaarten" als de boog hem nodig heeft`);
    }
  }
  return uit;
}

// ------------------------------------------------------------ merkveiligheid

/** Woorden die een clip framen als "betrapt op een fout". */
const FOUT_TAAL = [
  'fout', 'klopt niet', 'kan niet kloppen', 'niet kan kloppen', 'rekenfout', 'betrapt', 'liegt', 'gelogen', 'onzin', 'misleid',
  'verkeerd', 'blunder', 'tegenspraak', 'spreekt zichzelf tegen', 'eigen cijfers', 'zegt het anders', 'onmogelijk',
];

/**
 * Bij een campagne is de bronvideo meestal van de klant zelf. Een clip die
 * de klant, zijn product of zijn eigen video op een fout betrapt, belachelijk
 * maakt of tegenspreekt is merkonveilig — ook als het verhaal klopt. Lichte
 * check op taal: het oordeel (risico "merkonveilig" → schrappen) ligt bij het
 * examen en de verhaaldokter.
 */
export function keurMerkveiligheid(clip: Clip, campagneNaam?: string | null): string[] {
  if (!campagneNaam) return [];
  const tekst = [
    clip.titel_intern,
    clip.verhaallijn.belofte,
    clip.verhaallijn.open_vraag,
    clip.verhaallijn.payoff,
    clip.verhaallijn.omslag,
    clip.hook?.tekst_overlay,
    ...(clip.hooks ?? []).map((h) => h.tekst_overlay),
  ]
    .join(' ')
    .toLowerCase();
  const gevonden = FOUT_TAAL.filter((w) => tekst.includes(w));
  if (gevonden.length === 0 || clip.risico === 'merkonveilig') return [];
  return [
    `campagne "${campagneNaam}": de clip is geframed als fout/tegenspraak ("${gevonden.slice(0, 3).join('", "')}") — betrapt hij de klant of diens eigen video? Dan is hij merkonveilig en vervalt hij`,
  ];
}

/** Schrapt clips die het examen of de verhaaldokter merkonveilig noemde. Levert het aantal geschrapte clips. */
export function pasMerkveiligheidToe(plan: ClipPlan): { plan: ClipPlan; geschrapt: string[] } {
  const geschrapt = plan.clips.filter((c) => c.risico === 'merkonveilig').map((c) => c.titel_intern);
  return { plan: { clips: plan.clips.filter((c) => c.risico !== 'merkonveilig') }, geschrapt };
}

/** Compact voor in een prompt: de verhaaldokter checkt deze punten expliciet. */
export function rapportVoorPrompt(rapport: VerhaaldokterRapport): string {
  if (rapport.signalen.length === 0) return '';
  return `\n\n=== MECHANISCHE SIGNALEN (geen oordeel — wel de moeite van het checken) ===\n${rapport.signalen
    .map((s) => `clip ${s.clipIndex + 1} "${s.titel}": ${s.signaal}`)
    .join('\n')}`;
}
