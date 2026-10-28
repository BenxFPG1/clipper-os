/**
 * Tests voor de brontranscriptie per bereik (woorden.ts → haalBronWoorden):
 * alleen de bereiken van de opdracht, gecachet per bereik, de oorzaak in de
 * log als het misgaat, en dan grove woordtijden uit het videotranscript.
 * Plus: de ondertitelcorrectie krijgt de captions als context. Met een
 * gestubde transcriptie en een cache in het geheugen; ffmpeg knipt echt.
 *
 * Draaien: npm run test:bronwoorden
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { groveWoorden, haalBronWoorden, type BronWoord, type BronWoordCache } from '../src/lib/roughcut/woorden';
import { corrigeerWoorden, pasCorrectiesToe, tweedeLezing } from '../src/lib/roughcut/ondertitelwoorden';
import { bouwAss, groepeerRegels, keurOndertitelOverlap, REGEL_GAT, vasteSpelling, woordenOpTijdlijn } from '../src/lib/roughcut/ondertitels';
import { editorTekst } from '../src/lib/roughcut/editortekst';
import { kaartSchema } from '../src/lib/planner/schema';
import type { Shot } from '../src/lib/roughcut';
import { instelling } from '../src/lib/roughcut/instellingen';

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

function geheugenCache(): BronWoordCache & { data: Map<string, BronWoord[]> } {
  const data = new Map<string, BronWoord[]>();
  return { data, lees: async (k) => data.get(k) ?? null, schrijf: async (k, w) => void data.set(k, w) };
}

async function main() {
  const map = mkdtempSync(join(tmpdir(), 'clipper-test-bronwoorden-'));
  try {
    // Een "podcast" van 10 minuten (alleen geluid is genoeg).
    const bron = join(map, 'bron.m4a');
    const g = spawnSync(resolveBinary('ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=200:d=600', '-c:a', 'aac', bron]);
    toets('testbron gemaakt', g.status === 0);
    const duurVan = (wav: string) => Number(spawnSync(resolveBinary('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], { encoding: 'utf8' }).stdout.trim());

    console.log('alleen de bereiken van de opdracht');
    {
      const cache = geheugenCache();
      const aanroepen: { duur: number; timeout: number }[] = [];
      // Stub: één woord per seconde, tijden binnen het fragment.
      const transcribeer = async (wav: string, _m: string, timeoutMs: number) => {
        const d = duurVan(wav);
        aanroepen.push({ duur: d, timeout: timeoutMs });
        return Array.from({ length: Math.floor(d) }, (_, i) => ({ w: `w${i}`, s: i + 0.1, e: i + 0.5 }));
      };
      const log: string[] = [];
      const shots = [
        { start: 100, end: 110 },
        { start: 112, end: 120 },
        { start: 400, end: 405 },
      ];
      const w = await haalBronWoorden('vid', bron, { bereiken: shots, transcribeer, cache, log: (m) => log.push(m) });
      const marge = instelling('BRON_BEREIK_MARGE');
      toets('twee bereiken (100–120 samengevoegd, 400–405 apart)', aanroepen.length === 2, JSON.stringify(aanroepen));
      toets('bereik = shots + marge, niet de hele video', Math.abs(aanroepen[0].duur - (20 + 2 * marge)) < 0.2 && Math.abs(aanroepen[1].duur - (5 + 2 * marge)) < 0.2, JSON.stringify(aanroepen));
      toets('time-out schaalt met de audioduur (min. 120 s)', aanroepen.every((a) => a.timeout >= 120_000), JSON.stringify(aanroepen));
      toets('woorden op brontijd (offset van het bereik erbij)', Boolean(w && w[0].s === 100 - marge + 0.1), String(w?.[0]?.s));
      toets('elk bereik apart gecachet', cache.data.size === 2 && [...cache.data.keys()].every((k) => /^woorden\/vid-small-\d+\.\d-\d+\.\d\.json$/.test(k)), [...cache.data.keys()].join(', '));
      toets('logregel met bereiken', log.some((m) => /^brontranscriptie: 2 bereik\(en\) rond 3 shot\(s\) — .*nieuw/.test(m)), log.join(' | '));
      aanroepen.length = 0;
      const log2: string[] = [];
      const w2 = await haalBronWoorden('vid', bron, { bereiken: shots, transcribeer, cache, log: (m) => log2.push(m) });
      toets('tweede keer uit de cache, niets getranscribeerd', aanroepen.length === 0 && w2?.length === w?.length, log2.join(' | '));
      cache.data.set('woorden/vid-small.json', Array.from({ length: 60 }, (_, i) => ({ w: `h${i}`, s: i, e: i + 0.5 })));
      const w3 = await haalBronWoorden('vid', bron, { bereiken: shots, transcribeer, cache });
      toets('bestaande hele-video-cache gaat voor', w3?.[0].w === 'h0' && aanroepen.length === 0);
    }

    console.log('mislukt: oorzaak in de log, grove woorden uit het transcript');
    {
      const cache = geheugenCache();
      const transcript = [
        { start_seconds: 98, end_seconds: 104, text: 'Skaardjaptom zegt dat het eten top is' },
        { start_seconds: 104, end_seconds: 108, text: 'echt waar broer' },
        { start_seconds: 300, end_seconds: 304, text: 'buiten het bereik' },
      ];
      const log: string[] = [];
      const w = await haalBronWoorden('vid2', bron, {
        bereiken: [{ start: 100, end: 107 }],
        transcript,
        transcribeer: async () => {
          throw new Error('align.py exit 1: RuntimeError: model small niet te laden');
        },
        cache,
        log: (m) => log.push(m),
      });
      toets('oorzaak staat in de log', log.some((m) => /transcriptie \d+-\d+ s mislukt: align\.py exit 1: RuntimeError: model small niet te laden — terugval op het videotranscript \(\d+ woorden, grof\)/.test(m)), log.join(' | '));
      toets('er zijn woorden (grof)', Boolean(w && w.length === 10 && w.every((x) => x.grof)), JSON.stringify(w?.slice(0, 3)));
      toets('buiten het bereik niets', Boolean(w && w.every((x) => x.s < 200)));
      toets('logregel waarschuwt voor grove tijden', log.some((m) => /⚠ 10 grove woordtijden/.test(m)), log.join(' | '));
      toets('grof wordt niet gecachet', cache.data.size === 0);
      const leeg = await haalBronWoorden('vid3', bron, { bereiken: [{ start: 100, end: 107 }], transcribeer: async () => [], cache: geheugenCache(), log: (m) => log.push(m) });
      toets('zonder transcript en zonder woorden: null, met reden', leeg === null && log.some((m) => /model gaf geen woorden terug — geen videotranscript/.test(m)));
    }

    console.log('grove woordtijden');
    {
      const w = groveWoorden([{ start_seconds: 10, end_seconds: 14, text: 'ik eet [muziek] heel veel' }]);
      toets('woorden evenredig binnen het segment', w.length === 4 && w[0].s === 10 && w[3].e <= 14 && w[3].e > 13.5, JSON.stringify(w));
      toets('langer woord krijgt meer tijd', w[2].e - w[2].s > w[0].e - w[0].s);
      toets('gaten tussen de woorden (woordgrenzen)', w.every((x, i) => i === 0 || x.s > w[i - 1].e));
      toets('[muziek] en dergelijke vallen weg', !w.some((x) => /\[/.test(x.w)));
    }

    console.log('ondertitels overlappen nooit');
    {
      // YouTube-captions overlappen (rollend), en elk blok begint met een
      // sprekerstreepje: zo ontstonden "Htoch?:Scar" en "rekening.-Dat".
      const captions = [
        { start_seconds: 10, end_seconds: 13.5, text: 'wie betaalt de rekening.' },
        { start_seconds: 12.2, end_seconds: 15.8, text: '-Dat is toch? Scarom' },
        { start_seconds: 15.0, end_seconds: 18.0, text: '- Hm.. ja precies' },
      ];
      const grof = groveWoorden(captions);
      toets('grove woorden uit overlappende captions overlappen niet', grof.every((w, i) => i === 0 || w.s >= grof[i - 1].e), JSON.stringify(grof.map((w) => [w.w, w.s, w.e])));
      toets('sprekerstreepje verdwijnt', !grof.some((w) => w.w.startsWith('-')), grof.map((w) => w.w).join(' '));
      const shots: Shot[] = [{ volgorde: 1, start: 9.8, end: 18, functie: 'setup' }];
      // Plus een dubbel binnengekomen woord en een los overlappend woord.
      const woorden = [...grof, { w: 'toch?', s: grof.find((w) => w.w === 'toch?')!.s + 0.03, e: grof.find((w) => w.w === 'toch?')!.e + 0.02 }, { w: 'eh', s: 14.1, e: 14.9 }];
      const regels = groepeerRegels(woordenOpTijdlijn(shots, woorden));
      const k = keurOndertitelOverlap(regels);
      toets('keuring: ondertitels overlappen niet', k.goed === true, k.detail);
      toets('dubbel woord valt weg', regels.flatMap((r) => r.woorden).filter((w) => w.w === 'toch?').length === 1);
      toets('geen "rekening.-Dat" meer', !regels.some((r) => r.woorden.some((w) => /\.-/.test(w.w))), regels.map((r) => r.woorden.map((w) => w.w).join(' ')).join(' | '));
      // ASS: nooit twee dialoogregels tegelijk.
      const ass = bouwAss(regels, { accent: '#ff8800' });
      const tijd = (x: string) => { const [u, m, sec] = x.split(':'); return Number(u) * 3600 + Number(m) * 60 + Number(sec); };
      const dia = [...ass.matchAll(/^Dialogue: 0,([^,]+),([^,]+),/gm)].map((m) => [tijd(m[1]), tijd(m[2])]).sort((a, b) => a[0] - b[0]);
      toets('ASS: nooit twee dialogen tegelijk in beeld', dia.every((d, i) => i === 0 || d[0] >= dia[i - 1][1] - 1e-6), JSON.stringify(dia.slice(0, 8)));
      // Een keuring die een echte overlap ook ziet.
      const fout = [
        { s: 0, e: 1.2, woorden: [{ w: 'a', s: 0, e: 0.5 }] },
        { s: 1.0, e: 2, woorden: [{ w: 'b', s: 1.0, e: 1.5 }] },
      ];
      toets('keuring ziet een overlap', keurOndertitelOverlap(fout).goed === false);
      toets(`gat tussen regels ≥ ${REGEL_GAT * 1000} ms`, regels.every((r, i) => i === 0 || r.s - regels[i - 1].e >= REGEL_GAT - 1e-6));
      // Shots niet in volgnummer-volgorde in de array: de tijdlijn volgt de render.
      const bron = [{ w: 'een', s: 1, e: 1.3 }, { w: 'twee', s: 5, e: 5.3 }];
      const omgekeerd = woordenOpTijdlijn([{ volgorde: 2, start: 4.9, end: 5.5, functie: 'setup' }, { volgorde: 1, start: 0.9, end: 1.5, functie: 'setup' }], bron);
      toets('woorden in render-volgorde (op volgnummer)', omgekeerd.map((w) => w.w).join(' ') === 'een twee' && omgekeerd[1].s > omgekeerd[0].s);
      // Twee aansluitende shots (een graphic-splitsing): een woord op de grens
      // hoort in één van beide, niet in allebei (PLATINA clip 4: "2,238,238").
      const grens = woordenOpTijdlijn(
        [{ volgorde: 1, start: 0, end: 1, functie: 'setup' }, { volgorde: 2, start: 1, end: 2, functie: 'setup' }],
        [{ w: '2', s: 0.6, e: 0.9 }, { w: ',238', s: 0.97, e: 1.2 }, { w: 'miljoen', s: 1.2, e: 1.6 }],
      );
      toets('woord op de grens van aansluitende shots één keer', grens.map((w) => w.w).join(' ') === '2,238 miljoen', JSON.stringify(grens));
      // Een woord dat grotendeels vóór de knip klinkt, staat niet in beeld ("Ten Bij goud").
      const voor = woordenOpTijdlijn([{ volgorde: 1, start: 0.95, end: 2, functie: 'setup' }], [{ w: 'Ten', s: 0.905, e: 0.96 }, { w: 'Bij', s: 1.1, e: 1.3 }]);
      toets('woord dat vóór de knip klinkt valt weg', voor.map((w) => w.w).join(' ') === 'Bij', JSON.stringify(voor));
      // Whisper rekt het begin van een woord na een pauze de stilte in: "Ten"
      // van 129,48 (echt 129,80) tot 129,94. Het geluid stopt op 129,71; het
      // midden (129,71) lag net binnen het shot en "Ten" stond in beeld.
      const gerekt = woordenOpTijdlijn(
        [{ volgorde: 3, start: 126.72, end: 129.72, functie: 'setup' }, { volgorde: 4, start: 202.36, end: 205.3, functie: 'payoff' }],
        [{ w: 'te', s: 128.94, e: 129.08 }, { w: 'draaien.', s: 129.08, e: 129.48 }, { w: 'Ten', s: 129.48, e: 129.94 }, { w: 'tweede', s: 129.94, e: 130.34 }, { w: 'ruimte.', s: 201.98, e: 202.34 }, { w: 'Bij', s: 202.48, e: 202.68 }, { w: 'goud', s: 202.68, e: 203.12 }],
      );
      toets('bij een echte knip alleen woorden die je hoort ("draaien. Bij goud")', gerekt.map((w) => w.w).join(' ') === 'te draaien. Bij goud', JSON.stringify(gerekt.map((w) => w.w)));
      // Een ondertitelregel loopt nooit over een knip heen ("Afrika De").
      const overKnip = groepeerRegels(woordenOpTijdlijn(
        [{ volgorde: 3, start: 135, end: 137.2, functie: 'setup' }, { volgorde: 4, start: 164.5, end: 166.5, functie: 'setup' }],
        [{ w: 'wereld', s: 135.2, e: 135.6 }, { w: 'komt', s: 135.6, e: 135.9 }, { w: 'uit', s: 135.9, e: 136.2 }, { w: 'Zuid-Afrika.', s: 136.3, e: 137.1 }, { w: 'De', s: 164.58, e: 164.7 }, { w: 'Platinamarkt', s: 164.7, e: 165.4 }, { w: 'heeft', s: 165.4, e: 165.7 }],
      ));
      toets('vaste spelling: industriele → industriële, volatiler → volatieler, rest ongemoeid', vasteSpelling('industriele') === 'industriële' && vasteSpelling('Financiele,') === 'Financiële,' && vasteSpelling('volatiler') === 'volatieler' && vasteSpelling('vele') === 'vele' && vasteSpelling('goud.') === 'goud.');
      toets('nieuwe regel na een knip, nooit "Afrika De"', overKnip.every((r) => !(r.woorden.some((w) => /Afrika/.test(w.w)) && r.woorden.some((w) => w.w === 'De'))), JSON.stringify(overKnip.map((r) => r.woorden.map((w) => w.w).join(' '))));
      toets('een losse slotzin-staart schuift bij de vorige regel als dat past', groepeerRegels([{ w: 'Het', s: 0, e: 0.2 }, { w: 'is', s: 0.2, e: 0.4 }, { w: 'zo', s: 0.4, e: 0.6 }, { w: 'klaar.', s: 0.6, e: 0.9 }]).map((r) => r.woorden.map((w) => w.w).join(' ')).join(' | ') === 'Het is zo klaar.', JSON.stringify(groepeerRegels([{ w: 'Het', s: 0, e: 0.2 }, { w: 'is', s: 0.2, e: 0.4 }, { w: 'zo', s: 0.4, e: 0.6 }, { w: 'klaar.', s: 0.6, e: 0.9 }]).map((r) => r.woorden.map((w) => w.w))));
    }

    console.log('correctie mag één fout in twee woorden splitsen');
    {
      const c = pasCorrectiesToe([{ w: 'duurtraloesje.', s: 1, e: 2 }], [{ index: 0, woord: 'duurste horloge' }]);
      toets('toegepast als twee woorden (leesteken blijft)', c.woorden[0].w === 'duurste horloge.' && c.toegepast.length === 1, JSON.stringify(c));
      const op = woordenOpTijdlijn([{ volgorde: 1, start: 0, end: 3, functie: 'setup' }], c.woorden);
      toets('op de tijdlijn twee woorden, tijd verdeeld', op.length === 2 && op[0].w === 'duurste' && op[1].w === 'horloge.' && op[0].e <= op[1].s + 1e-9 && op[1].e <= 2 + 1e-9, JSON.stringify(op));
      const vier = pasCorrectiesToe([{ w: 'x', s: 1, e: 2 }], [{ index: 0, woord: 'een twee drie vier' }]);
      toets('meer dan drie woorden: afgewezen en gemeld', vier.toegepast.length === 0 && vier.afgewezen.length === 1, JSON.stringify(vier.afgewezen));
    }

    console.log('kaarten: tekst voor de kijker, geen editor-aanwijzing');
    {
      for (const t of ['Hier opende deze clip mee', 'Cold open', '2 minuten later', 'Zie boven', 'Flashback naar 2019', 'Tijdsprong', 'Voor de editor: knip hier']) {
        toets(`"${t}" is editor-tekst`, editorTekst(t) !== null);
      }
      for (const t of ['€5.250.000', 'Wie betaalt de rekening?', 'Titanic was niet de ergste', 'Hij blijft in karakter', 'De video ging viraal', '€105.000 · betaald in 10 minuten']) {
        toets(`"${t}" is kijkertekst`, editorTekst(t) === null, String(editorTekst(t)));
      }
      const r = kaartSchema.safeParse({ shot: 3, tekst: 'Hier opende deze clip mee' });
      toets('planner-schema weigert editor-tekst (repair-ronde)', !r.success && /aanwijzing voor de editor/.test(r.error.message), r.success ? '' : r.error.message);
      toets('planner-schema accepteert kijkertekst', kaartSchema.safeParse({ shot: 3, tekst: '€5.250.000' }).success);
    }

    console.log('ondertitelcorrectie met captions');
    {
      let gezien = '';
      let systeem = '';
      await corrigeerWoorden([{ w: 'Skaard-japtom', s: 1, e: 1.4 }], { titel: 'Mukbang', captions: 'Skaardjaptom zegt dat het eten top is' }, async (sys, user) => {
        systeem = sys;
        gezien = user;
        return { correcties: [] };
      });
      toets('captions gaan mee als context', /Ondertitels van de video zelf voor dit stuk.*\nSkaardjaptom zegt/.test(gezien), gezien);
      toets('en zijn leidend voor spelling van straattaal', /straattaal/.test(systeem));
      let zonder = '';
      await corrigeerWoorden([{ w: 'x', s: 1, e: 1.4 }], { titel: 'Mukbang' }, async (_s, user) => {
        zonder = user;
        return { correcties: [] };
      });
      toets('zonder captions geen leeg blok', !/Ondertitels van de video zelf/.test(zonder));
    }

    console.log('ondertitelcorrectie: geen spellingsgokken, twijfel tussen modellen expliciet (PLATINA ronde 9)');
    {
      // Ronde 9: het lichte model maakte van "volatiler" "volatider", en het
      // grote model hoorde "En een prijs" waar "En de prijs" gezegd werd.
      const gok = pasCorrectiesToe([{ w: 'volatiler', s: 1, e: 2 }], [{ index: 0, woord: 'volatider' }], { fragmenten: ['Dat maakt het volatiler'] });
      toets('spellingsgok zonder bron afgewezen', gok.toegepast.length === 0 && gok.afgewezen[0]?.waarom === 'spellingsgok zonder bron', JSON.stringify(gok));
      const metBron = pasCorrectiesToe([{ w: 'platinum', s: 1, e: 2 }], [{ index: 0, woord: 'platina' }], { titel: 'Platina: zeldzamer dan goud' });
      toets('kleine wijziging mét bron in de context: toegepast', metBron.toegepast.length === 1, JSON.stringify(metBron));
      const tweede = pasCorrectiesToe([{ w: 'Rendment', s: 1, e: 2 }], [{ index: 0, woord: 'Rendement' }], { tweede: ['rendement'] });
      toets('kleine wijziging die de tweede herkenning bevestigt: toegepast', tweede.toegepast.length === 1);
      const groot = pasCorrectiesToe([{ w: 'enimetaal', s: 1, e: 2 }], [{ index: 0, woord: 'edelmetaal' }]);
      toets('echte herkenningsfout (groot verschil) blijft toegestaan', groot.toegepast.length === 1);
      toets('"volatider" staat in de ondertitels als "volatieler"', vasteSpelling('volatider.') === 'volatieler.');

      const groot2 = [{ w: 'En', s: 0, e: 0.2 }, { w: 'een', s: 0.2, e: 0.35 }, { w: 'prijs', s: 0.35, e: 0.7 }];
      const klein = [{ w: 'En', s: 0, e: 0.18 }, { w: 'de', s: 0.2, e: 0.33 }, { w: 'prijs', s: 0.36, e: 0.7 }];
      const t = tweedeLezing(groot2, klein);
      toets('tweede lezing per woord op tijd', JSON.stringify(t) === '["En","de","prijs"]', JSON.stringify(t));
      let gezien = '';
      let systeem = '';
      await corrigeerWoorden(groot2, { tweede: t }, async (sys, user) => {
        systeem = sys;
        gezien = user;
        return { correcties: [{ index: 1, woord: 'de' }] };
      });
      toets('verschil tussen de modellen staat bij het woord', / 1:een≠de /.test(gezien) && !/prijs≠/.test(gezien), gezien);
      toets('prompt eist een keuze op die plekken', /Kies op die plekken ALTIJD expliciet/.test(systeem));
      // Ronde 12: de brede pas liet "een" staan. Dan volgt altijd de gerichte keuzevraag.
      let gevraagd = '';
      const r12 = await corrigeerWoorden(
        groot2,
        { tweede: t },
        async () => ({ correcties: [] }),
        async (_s, user) => {
          gevraagd = user;
          return { keuzes: [{ index: 1, woord: 'de' }] };
        },
      );
      toets('gerichte keuzevraag met beide opties in de zin', /1: En \[een \| de\] prijs/.test(gevraagd), gevraagd);
      toets('keuze "de" toegepast', r12.woorden[1].w === 'de', JSON.stringify(r12.woorden));
      const raar = await corrigeerWoorden(groot2, { tweede: t }, async () => ({ correcties: [] }), async () => ({ keuzes: [{ index: 1, woord: 'het' }] }));
      toets('een antwoord dat geen van beide opties is: genegeerd', raar.woorden[1].w === 'een');
      const brede = await corrigeerWoorden(groot2, { tweede: t }, async () => ({ correcties: [{ index: 1, woord: 'een' }] }), async () => ({ keuzes: [{ index: 1, woord: 'de' }] }));
      toets('de gerichte vraag beslist, ook als de brede pas al "een" koos', brede.woorden[1].w === 'de', JSON.stringify(brede.woorden));
    }
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
