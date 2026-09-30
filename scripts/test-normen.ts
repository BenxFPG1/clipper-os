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
  gepaardeToets,
  groepeer,
  accountSleutel,
  wilcoxonSignedRank,
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

console.log('gepaarde analyse');
{
  const w8 = wilcoxonSignedRank([1, 2, 3, 4, 5, 6, 7, 8])!;
  toets('Wilcoxon: 8 van 8 positief → p = 2/256', w8.wPlus === 36 && Math.abs(w8.p - 2 / 256) < 1e-12 && w8.r === 1, JSON.stringify(w8));
  const w7 = wilcoxonSignedRank([-1, 2, 3, 4, 5, 6, 7, 8])!;
  toets('Wilcoxon: kleinste negatief → p = 4/256', w7.wPlus === 35 && Math.abs(w7.p - 4 / 256) < 1e-12, JSON.stringify(w7));
  const wSym = wilcoxonSignedRank([1, -1, 2, -2, 3, -3, 4, -4])!;
  toets('Wilcoxon: symmetrisch → p = 1, r = 0', wSym.p === 1 && wSym.r === 0);
  const wTies = wilcoxonSignedRank([1, 1, 1, 1, 1, 1, 1, 1, 0, 0])!;
  toets('Wilcoxon: nullen vallen weg, ties mogen', wTies.n === 8 && Math.abs(wTies.p - 2 / 256) < 1e-12, JSON.stringify(wTies));
  toets('Wilcoxon: alleen nullen → null', wilcoxonSignedRank([0, 0]) === null);

  const g = gepaardeToets([
    { account: 'a', groep: 'top', w: 5 }, { account: 'a', groep: 'top', w: 7 }, { account: 'a', groep: 'basis', w: 4 },
    { account: 'b', groep: 'top', w: 1 }, { account: 'b', groep: 'basis', w: 3 },
    { account: 'c', groep: 'top', w: 9 }, // geen basis → geen paar
  ])!;
  toets('gepaardeToets: mediaan per account, alleen paren', g.n_accounts === 2 && g.hoger === 1 && g.lager === 1 && g.top === 3.5 && g.mediaan_verschil === 0, JSON.stringify(g));

  toets('accountSleutel: handle uit URL, platform erbij', accountSleutel('https://www.tiktok.com/@JordFinance/video/1', 'x') === 'tiktok:jordfinance');
  toets('accountSleutel: zonder handle → tracked id', accountSleutel('https://www.youtube.com/shorts/abc', 'id1') === 'id:id1' && accountSleutel(null, null) === null);

  // Het echte probleem: accounts verschillen sterk in stijl (1 tot 12
  // wissels/10 s), binnen elk account knipt de uitschieter iets sneller.
  // Ongepaard verdrinkt dat; gepaard ziet het.
  const metingen: Meting[] = [];
  for (let a = 0; a < 10; a++) {
    const stijl = 1 + a * 1.2;
    for (let j = 0; j < 2; j++) {
      metingen.push({ groep: 'top', platform: 'tiktok', theme: null, account: `acc${a}`, v: vinger({ wisselsPer10s: stijl + 0.8 + j * 0.1, loudnessI: -14 + j }) });
      metingen.push({ groep: 'basis', platform: 'tiktok', theme: null, account: `acc${a}`, v: vinger({ wisselsPer10s: stijl + j * 0.1, loudnessI: -14 + (1 - j) }) });
    }
  }
  const n = aggregeerNormen(metingen);
  const ongepaard = aggregeerNormen(metingen.map((m) => ({ ...m, account: null })));
  toets('ongepaard ziet het verschil niet (stijl overheerst)', ongepaard.wisselsPer10s?.norm_extern === false && ongepaard.wisselsPer10s?.methode === 'ongepaard', JSON.stringify(ongepaard.wisselsPer10s?.effect));
  toets('gepaard ziet het wel: 10 van 10 accounts hoger', n.wisselsPer10s?.norm_extern === true && n.wisselsPer10s?.methode === 'gepaard' && n.wisselsPer10s?.gepaard?.hoger === 10, JSON.stringify(n.wisselsPer10s?.gepaard));
  toets('gepaard: geen verschil in loudness → geen norm', n.loudnessI?.norm_extern === false && n.loudnessI?.methode === 'gepaard');
  const d = doelenUitNormen(n, metingen.length);
  toets('doel uit gepaarde top-mediaan per account', d.knippenPer10s === 7 && d.bronPerDoel.knippenPer10s === 'extern', String(d.knippenPer10s));
  const t = normenTekst(n, 'tiktok', 'all');
  toets('prompt noemt methode en aantal accounts', /gepaard: uitschieter vs gewone post van hetzelfde account, 10 accounts/.test(t), t);
  toets('prompt: hoger bij 10 van 10 accounts', /hoger bij 10 van 10 accounts/.test(t), t);
  toets('prompt: loudness als niet-verschillend', /Verschilt NIET[^\n]*loudness/.test(t), t);

  // Minder dan 8 accounts met beide soorten → terug naar ongepaard.
  const weinig = aggregeerNormen(metingen.filter((m) => Number(m.account!.slice(3)) < 5 || m.groep === 'top'));
  toets('<8 paren → ongepaarde terugval', weinig.wisselsPer10s?.methode === 'ongepaard' && weinig.wisselsPer10s?.gepaard?.n_accounts === 5);
}

{
  // Ongepaarde terugval: uit te weinig accounts, of gelijke medianen → geen norm.
  const uitTweeAccounts: Meting[] = [
    ...reeks(10, 'top', (i) => ({ eersteWisselS: 0.6 + i * 0.01 })).map((m, i) => ({ ...m, account: `a${i % 2}` })),
    ...reeks(10, 'basis', (i) => ({ eersteWisselS: 3 + i * 0.01 })).map((m, i) => ({ ...m, account: `b${i % 2}` })),
  ];
  const n2 = aggregeerNormen(uitTweeAccounts);
  toets('ongepaard uit 2 accounts per groep → geen norm', n2.eersteWisselS?.methode === 'ongepaard' && n2.eersteWisselS?.norm_extern === false);
  const staart = aggregeerNormen([
    ...reeks(10, 'top', () => ({ spraakStartS: 0 })),
    ...reeks(10, 'basis', (i) => ({ spraakStartS: i < 6 ? 0 : 1.5 })),
  ]);
  toets('gelijke medianen → geen norm, ook bij effect ≥ 0,33', staart.spraakStartS?.norm_extern === false && Math.abs(staart.spraakStartS?.effect ?? 0) >= 0.33, JSON.stringify(staart.spraakStartS));
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
  toets('noemt de gemeten verschillen met n', /eerste visuele wissel: top 0,8 s vs gewone posts 2,9 s \(ongepaard, n=10\/10\)/.test(t), t);
  toets('zegt welke methode (ongepaard zonder accounts)', /ongepaard: alle uitschieters/.test(t));
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

// Richting: een geleerd doel mag nooit tegen de data in bewegen (comedy:
// top 6,3 s zonder wissel vs basis 8,8 s mocht geen doel van 6,5 s geven).
{
  const n = { top: 20, basis: 20, eigen_goed: 0, eigen_weg: 0 } as never;
  const strakker = doelenUitNormen(
    { langsteZonderWisselS: { top: 6.3, basis: 8.8, eigen_goed: null, eigen_weg: null, effect: -0.4, effect_eigen: null, n, norm_extern: true, norm_eigen: false } },
    40,
  );
  toets('top strakker dan basis → doel niet ruimer dan standaard', strakker.maxSecondenZonderVisueleVerandering === STANDAARD_DOELEN.maxSecondenZonderVisueleVerandering, String(strakker.maxSecondenZonderVisueleVerandering));
  const ruimer = doelenUitNormen(
    { langsteZonderWisselS: { top: 6.3, basis: 3.0, eigen_goed: null, eigen_weg: null, effect: 0.5, effect_eigen: null, n, norm_extern: true, norm_eigen: false } },
    40,
  );
  toets('top ruimer dan basis → doel mag ruimer', ruimer.maxSecondenZonderVisueleVerandering === 6.5, String(ruimer.maxSecondenZonderVisueleVerandering));
}

terugval().then(() => {
  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
});
