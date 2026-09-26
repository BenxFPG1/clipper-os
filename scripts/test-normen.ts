/**
 * Tests voor de edit-normen en de pure delen van de vingerafdruk: effect-
 * grootte, aggregatie top vs basis, grenzen op de doelen, de terugval naar
 * de standaard en het parsen van ffmpeg-uitvoer. Geen database, geen model,
 * geen netwerk — zelfde patroon als test-trends.
 *
 * Draaien: npm run test:normen
 */
// Zonder env faalt editDoelen() netjes terug naar de standaard; dit dwingt
// dat pad af, ook als er lokaal een .env met echte keys staat.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import {
  STANDAARD_DOELEN,
  aggregeerNormen,
  begrens,
  cliffsDelta,
  doelenUitNormen,
  editDoelen,
  editNormenVoorPrompt,
  groepeer,
  mediaan,
  normenTekst,
  schoneDoelen,
  type Meting,
} from '../src/lib/vault/normen';
import {
  frameTijden,
  ontdubbelWissels,
  parseAudio,
  parseScores,
  shotStatistiek,
  spraakMaten,
  tekstMaten,
  wisselsUitScores,
  type Vingerafdruk,
} from '../src/lib/analyse/vingerafdruk';
import { kiesBasislijn } from '../src/lib/agents/scout';

let gefaald = 0;
let gedaan = 0;

function toets(naam: string, voorwaarde: boolean, detail = '') {
  gedaan++;
  if (voorwaarde) console.log(`  ✓ ${naam}`);
  else {
    gefaald++;
    console.log(`  ✗ ${naam}${detail ? ` — ${detail}` : ''}`);
  }
}

function vinger(over: Partial<Vingerafdruk> & { tekst?: number; zonderTekst?: number } = {}): Vingerafdruk {
  const { tekst, zonderTekst, ...rest } = over;
  return {
    versie: 1,
    gemeten_at: '2026-09-26T00:00:00Z',
    duurS: 30,
    wissels: [],
    aantalWissels: 6,
    wisselsPer10s: 2,
    wisselsEerste3s: 0,
    eersteWisselS: 3,
    gemShotS: 5,
    mediaanShotS: 5,
    langsteZonderWisselS: 8,
    spraakStartS: 0.3,
    pauzesAantal: 2,
    pauzesTotaalS: 1,
    pauzesPerMin: 4,
    pauzeBron: 'stilte',
    loudnessI: -14,
    loudnessLRA: 4,
    woordenPerS: 2.8,
    visueel:
      tekst === undefined
        ? null
        : {
            frames: [],
            ondertitelstijl: 'zin',
            ondertitel_positie: 'onder',
            kader: 'close',
            beweging_zoom_zichtbaar: false,
            broll: false,
            eerste_frame_hook: '',
            tekstInBeeldAandeel: tekst,
            langsteZonderTekstS: zonderTekst ?? 1,
            tekstInEersteFrame: tekst > 0.5,
          },
    opmerkingen: [],
    ...rest,
  };
}

/** n metingen met een beetje spreiding rond een waarde, deterministisch. */
function reeks(n: number, groep: Meting['groep'], maak: (i: number) => Partial<Vingerafdruk> & { tekst?: number; zonderTekst?: number }, platform = 'tiktok', theme: string | null = 'sport'): Meting[] {
  return Array.from({ length: n }, (_, i) => ({ groep, platform, theme, v: vinger(maak(i)) }));
}

console.log('statistiek');
{
  toets('mediaan oneven', mediaan([3, 1, 2]) === 2);
  toets('mediaan even', mediaan([1, 2, 3, 4]) === 2.5);
  toets('mediaan leeg = null', mediaan([]) === null);
  toets('cliffsDelta volledig gescheiden = 1', cliffsDelta([5, 6, 7], [1, 2, 3]) === 1);
  toets('cliffsDelta omgekeerd = -1', cliffsDelta([1, 2], [5, 6]) === -1);
  toets('cliffsDelta gelijk = 0', cliffsDelta([1, 2, 3], [1, 2, 3]) === 0);
  toets('cliffsDelta lege groep = null', cliffsDelta([], [1]) === null);
  // Rangmaat: één absurde meting verandert het effect nauwelijks.
  const zonder = cliffsDelta([1, 1.1, 1.2, 1.3], [2, 2.1, 2.2, 2.3])!;
  const met = cliffsDelta([1, 1.1, 1.2, 99], [2, 2.1, 2.2, 2.3])!;
  toets('één uitschieter verschuift de rang beperkt', zonder === -1 && met === -0.5, `${zonder} → ${met}`);
}

console.log('aggregeerNormen');
{
  // Top knipt vroeg en vaak, basis laat en weinig; loudness gelijk.
  const metingen = [
    ...reeks(10, 'top', (i) => ({ eersteWisselS: 0.6 + i * 0.05, wisselsPer10s: 4 + i * 0.1, loudnessI: -14 + (i % 3) })),
    ...reeks(10, 'basis', (i) => ({ eersteWisselS: 2.5 + i * 0.1, wisselsPer10s: 1.5 + i * 0.1, loudnessI: -14 + (i % 3) })),
  ];
  const n = aggregeerNormen(metingen);
  toets('eerste wissel is een externe norm', n.eersteWisselS?.norm_extern === true, JSON.stringify(n.eersteWisselS));
  toets('mediaan top ~0,8 s', Math.abs((n.eersteWisselS?.top ?? 0) - 0.825) < 0.01, String(n.eersteWisselS?.top));
  toets('effect negatief (top lager)', (n.eersteWisselS?.effect ?? 0) < -0.9);
  toets('wissels/10s is een norm', n.wisselsPer10s?.norm_extern === true);
  toets('loudness verschilt niet → geen norm', n.loudnessI?.norm_extern === false, JSON.stringify(n.loudnessI));
  toets('visuele kenmerken zonder visuele pas ontbreken', n.tekstInBeeldAandeel === undefined);
  toets('n per groep klopt', n.eersteWisselS?.n.top === 10 && n.eersteWisselS?.n.basis === 10);
}
{
  // Groot verschil maar te weinig metingen → geen norm.
  const metingen = [...reeks(5, 'top', () => ({ eersteWisselS: 0.5 })), ...reeks(5, 'basis', () => ({ eersteWisselS: 3 }))];
  const n = aggregeerNormen(metingen);
  toets('n<8 per groep → geen norm, ook bij groot effect', n.eersteWisselS?.norm_extern === false && n.eersteWisselS?.effect === -1);
}
{
  // Eigen goed vs weg telt los van extern.
  const metingen = [
    ...reeks(9, 'eigen_goed', (i) => ({ tekst: 0.95, zonderTekst: 0.5 + i * 0.05 })),
    ...reeks(9, 'eigen_weg', (i) => ({ tekst: 0.4, zonderTekst: 3 + i * 0.1 })),
  ];
  const n = aggregeerNormen(metingen);
  toets('eigen norm op tekst in beeld', n.tekstInBeeldAandeel?.norm_eigen === true && n.tekstInBeeldAandeel?.norm_extern === false);
  const d = doelenUitNormen(n, 18);
  toets('doel uit eigen data → bron eigen', d.bron === 'eigen' && d.bronPerDoel.tekstInBeeldAandeel === 'eigen', JSON.stringify(d));
  toets('tekstInBeeldAandeel afgerond omlaag op 0,05 en ≤0,98', d.tekstInBeeldAandeel === 0.95, String(d.tekstInBeeldAandeel));
}

console.log('doelen: grenzen en afronding');
{
  toets('maximum rondt naar boven af', begrens(0.81, 0.5, 3, 0.1, 'op') === 0.9);
  toets('streefaantal rondt naar beneden af', begrens(4.3, 1, 8, 0.5, 'neer') === 4);
  toets('ondergrens houdt stand', begrens(0.05, 0.5, 3, 0.1, 'op') === 0.5);
  toets('bovengrens houdt stand', begrens(40, 1, 8, 0.5, 'neer') === 8);
  toets('exacte stap blijft staan', begrens(0.8, 0.5, 3, 0.1, 'op') === 0.8);

  // Eén rare meting (compilatie met 60 wissels/10 s) mag geen absurd doel opleveren.
  const metingen = [
    ...reeks(10, 'top', (i) => ({ wisselsPer10s: i === 0 ? 60 : 30 + i, eersteWisselS: 0.1, langsteZonderWisselS: 0.5 })),
    ...reeks(10, 'basis', (i) => ({ wisselsPer10s: 1 + i * 0.1, eersteWisselS: 4, langsteZonderWisselS: 12 })),
  ];
  const d = doelenUitNormen(aggregeerNormen(metingen), 20);
  toets('knippenPer10s begrensd op 8', d.knippenPer10s === 8, String(d.knippenPer10s));
  toets('eersteKnipMaxS niet onder 0,5', d.eersteKnipMaxS === 0.5, String(d.eersteKnipMaxS));
  toets('maxZonderWissel niet onder 2', d.maxSecondenZonderVisueleVerandering === 2);
  toets('niet-geleerde doelen blijven standaard', d.maxPauzeS === STANDAARD_DOELEN.maxPauzeS && d.bronPerDoel.maxSecondenZonderTekst === undefined);
  toets('bron extern, n = totaal', d.bron === 'extern' && d.n === 20);
}
{
  // Extern én eigen norm op hetzelfde kenmerk → midden, bron mix.
  const metingen = [
    ...reeks(8, 'top', () => ({ eersteWisselS: 0.6 })),
    ...reeks(8, 'basis', () => ({ eersteWisselS: 3 })),
    ...reeks(8, 'eigen_goed', () => ({ eersteWisselS: 1.2 })),
    ...reeks(8, 'eigen_weg', () => ({ eersteWisselS: 2.8 })),
  ];
  const d = doelenUitNormen(aggregeerNormen(metingen), 32);
  toets('mix: midden van extern en eigen', d.eersteKnipMaxS === 0.9 && d.bronPerDoel.eersteKnipMaxS === 'mix' && d.bron === 'mix', JSON.stringify(d));
}
{
  const d = doelenUitNormen({}, 0);
  toets('zonder normen: standaard, n=0', d.bron === 'standaard' && d.n === 0 && d.eersteKnipMaxS === STANDAARD_DOELEN.eersteKnipMaxS);
}

console.log('schoneDoelen');
{
  const d = schoneDoelen({ eersteKnipMaxS: 0.9, knippenPer10s: 'veel', bron: 'extern', onbekend: 5, bronPerDoel: {} });
  toets('kapot veld → standaard, bekend veld overgenomen', d.eersteKnipMaxS === 0.9 && d.knippenPer10s === STANDAARD_DOELEN.knippenPer10s);
  toets('geen onbekende velden erbij', !('onbekend' in d) && !('bronPerDoel' in d));
  toets('alle velden behalve bron zijn getallen', Object.entries(d).every(([k, w]) => k === 'bron' || typeof w === 'number'));
}

console.log('groepeer');
{
  const metingen: Meting[] = [
    { groep: 'top', platform: 'tiktok', theme: 'sport', v: vinger() },
    { groep: 'basis', platform: 'shorts', theme: null, v: vinger() },
    { groep: 'eigen_goed', platform: null, theme: null, v: vinger() },
  ];
  const g = groepeer(metingen);
  toets('all/all bevat alles', g.get('all|all')?.length === 3);
  toets('platform+thema-groep', g.get('tiktok|sport')?.length === 1 && g.get('tiktok|all')?.length === 1 && g.get('all|sport')?.length === 1);
  toets('zonder thema geen themagroep', !g.has('shorts|null') && g.get('shorts|all')?.length === 1);
}

console.log('normenTekst');
{
  const metingen = [
    ...reeks(10, 'top', (i) => ({ eersteWisselS: 0.8, wisselsPer10s: 4.2, loudnessI: -14 + (i % 2), tekst: 0.95 })),
    ...reeks(10, 'basis', (i) => ({ eersteWisselS: 2.9, wisselsPer10s: 2.1, loudnessI: -14 + (i % 2), tekst: 0.6 })),
  ];
  const t = normenTekst(aggregeerNormen(metingen), 'tiktok', 'sport');
  toets('noemt de gemeten verschillen met n', /eerste visuele wissel: top 0,8 s vs gewone posts 2,9 s \(n=10\/10\)/.test(t), t);
  toets('tekst in beeld als percentage', /tekst in beeld: top 95% vs gewone posts 60%/.test(t), t);
  toets('zegt wat NIET verschilt', /Verschilt NIET[^\n]*loudness/.test(t), t);
  toets('max 25 regels', t.split('\n').length <= 25);
  toets('zonder normen: lege string', normenTekst({}, 'all', 'all') === '');
}

// Async: draait na de synchrone blokken (tsx/cjs kent geen top-level await).
async function terugval() {
  console.log('terugval zonder database');
  const d = await editDoelen({ platform: 'tiktok', theme: 'sport' });
  toets('editDoelen valt terug op STANDAARD_DOELEN', d === STANDAARD_DOELEN || (d.bron === 'standaard' && d.n === 0));
  const p = await editNormenVoorPrompt({ platform: 'tiktok' });
  toets('editNormenVoorPrompt leeg zonder data', p === '');
}

console.log('vingerafdruk: pure delen');
{
  // Beweging (aanhoudend 0,045) is geen knip; een piek erboven wel.
  const scores = Array.from({ length: 90 }, (_, i) => ({ t: i / 30, s: 0.045 }));
  scores[45] = { t: 1.5, s: 0.09 };
  const stil = Array.from({ length: 90 }, (_, i) => ({ t: 3 + i / 30, s: 0.004 }));
  stil[30] = { t: 4, s: 0.07 };
  stil[60] = { t: 5, s: 0.5 };
  const w = wisselsUitScores([...scores, ...stil]);
  toets('piek boven beweging telt niet (0,09 vs 0,045 = 2x)', !w.includes(1.5), JSON.stringify(w));
  toets('zachte jump cut in stil beeld telt wel', w.includes(4));
  toets('harde knip telt altijd', w.includes(5));

  toets('ontdubbel: frame 0 en dubbele binnen 0,25 s weg', JSON.stringify(ontdubbelWissels([0, 1, 1.1, 1.4, 9.99], 10)) === '[1,1.4]');
  const s = shotStatistiek([2, 3, 7], 10);
  toets('shotstatistiek', s.langste === 4 && s.gem === 2.5 && s.mediaan === 2.5, JSON.stringify(s));
  toets('geen wissels: één shot van de hele duur', shotStatistiek([], 12).langste === 12);

  const uit = parseScores('frame:0 pts:0 pts_time:0\nlavfi.scene_score=0.000000\nframe:1 pts:512 pts_time:0.0333\nlavfi.scene_score=0.12\n');
  toets('parseScores', uit.length === 2 && uit[1].t === 0.0333 && uit[1].s === 0.12);

  const audio = parseAudio(
    '[silencedetect] silence_start: 0\n[silencedetect] silence_end: 0.62 | silence_duration: 0.62\n' +
      '[Parsed_ebur128_1] t: 1 M: -20 S: -30 I: -25.0 LUFS LRA: 0.0 LU\n' +
      '[silencedetect] silence_start: 5.1\n[silencedetect] silence_end: 5.8 | silence_duration: 0.7\n' +
      'Summary:\n  Integrated loudness:\n    I:         -13.9 LUFS\n  Loudness range:\n    LRA:         5.2 LU\n',
  );
  toets('parseAudio: stiltes', audio.stiltes.length === 2 && audio.stiltes[1].start === 5.1);
  toets('parseAudio: integrale loudness = samenvatting', audio.loudnessI === -13.9 && audio.loudnessLRA === 5.2, JSON.stringify(audio));
  toets('parseAudio: -70 LUFS = niets gemeten', parseAudio('Summary:\n I: -70.0 LUFS\n LRA: 0.0 LU').loudnessI === null);

  const m = spraakMaten({ woorden: null, segmenten: null, audio, duur: 10 });
  toets('spraakstart = einde openingsstilte, die telt niet als pauze', m.spraakStartS === 0.62 && m.pauzes.length === 1);
  const mw = spraakMaten({
    woorden: [
      { w: 'a', start: 0.2, end: 0.5 },
      { w: 'b', start: 0.5, end: 0.8 },
      { w: 'c', start: 1.5, end: 1.9 },
      { w: 'd', start: 1.9, end: 2.2 },
    ],
    segmenten: null,
    audio,
    duur: 10,
  });
  toets('woordtijden gaan voor stiltes', mw.pauzeBron === 'woorden' && mw.pauzes.length === 1 && mw.spraakStartS === 0.2 && mw.woordenPerS === 2);

  const onzin = spraakMaten({ woorden: null, segmenten: [{ start: 0, end: 100, tekst: 'la la la la' }], audio, duur: 120 });
  toets('tempo buiten 1–6 w/s wordt weggegooid (whisper-artefact)', onzin.woordenPerS === null);
  const echt = spraakMaten({ woorden: null, segmenten: [{ start: 1, end: 4, tekst: 'een twee drie vier vijf zes zeven acht negen' }], audio, duur: 10 });
  toets('normaal tempo blijft staan', echt.woordenPerS === 3 && echt.spraakStartS === 1);

  const tm = tekstMaten(
    [
      { seconde: 0, tekst_in_beeld: true },
      { seconde: 2, tekst_in_beeld: false },
      { seconde: 4, tekst_in_beeld: false },
      { seconde: 6, tekst_in_beeld: true },
    ],
    8,
  );
  toets('tekstMaten: aandeel tijdgewogen', Math.abs(tm.aandeel - 0.5) < 1e-9, JSON.stringify(tm));
  toets('tekstMaten: langste zonder tekst van 1 s tot 5 s', tm.langsteZonder === 4);
  const ft = frameTijden(30);
  toets('frameTijden: 8 frames, hook dicht', ft.length === 8 && ft.filter((t) => t < 3.5).length === 5, JSON.stringify(ft));
  toets('frameTijden: korte clip', frameTijden(2).every((t) => t < 2));
}

console.log('scout: kiesBasislijn');
{
  const post = (views: number | null, url = `u${views}`) => ({ post_url: url, posted_at: null, views, likes: null, comments: null, caption: null, handle: 'a', raw: null });
  const gekozen = kiesBasislijn([post(10_000), post(50_000), post(9_000), post(4_000), post(null), post(12_000)], 10_000);
  toets('dichtst bij de mediaan, geen uitschieters', JSON.stringify(gekozen.map((p) => p.views)) === '[10000,9000]', JSON.stringify(gekozen.map((p) => p.views)));
  toets('niets bij mediaan 0', kiesBasislijn([post(1)], 0).length === 0);
}

terugval().then(() => {
  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
});
