import 'dotenv/config';
/**
 * A/B van de planner-route: de snelle route (selectie + per clip parallel
 * uitschrijven, PLAN_ROUTE=parallel) tegen de baseline (het plan-7.x dat nu
 * in clip_plans staat, gemaakt met de grote examen-call en dezelfde
 * clipregels).
 *
 *   npx tsx scripts/ab-planner.ts <videoId> [<videoId> ...]
 *
 * Overschrijft niets in clip_plans: het A/B-plan gaat naar R2
 * (ab/<videoId>/<ts>.json) en naar scripts/ab/<videoId>.json; de uitslag
 * per video naar scripts/ab/<videoId>.md. Vergelijkt (a) duur, (b) aantal
 * clips en gekozen momenten (brontijd-overlap), (c) overtredingen van de
 * clipregels, (d) een blinde beoordeling door Opus per paar.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { db } from '../src/lib/supabase';
import { r2Upload } from '../src/lib/r2';
import { loadVault } from '../src/lib/vault';
import { structuredCall } from '../src/lib/claude';
import { TranscriptSegment, transcriptDuration } from '../src/lib/ingest/transcript';
import { generateClipPlan, laatstePlannerTijden } from '../src/lib/planner';
import { bronWoordenUitCache } from '../src/lib/roughcut/woorden';
import { lokaleBron } from '../src/lib/planner/signalen';
import { clipDuur, formaatVoorThema, regelOvertredingen, zinnen, type Formaat } from '../src/lib/planner/clipregels';
import { PROMPT_VERSION_PLAN, type CharacterMap, type Clip, type ClipPlan, type Energiemoment } from '../src/lib/planner/schema';

/**
 * De nieuwe route: wat er in de omgeving staat (standaard parallel, schets op
 * het lichte model). De baseline draait — als er geen plan met precies deze
 * promptversie in clip_plans staat, of met AB_BASELINE=draai — in hetzelfde
 * proces met de oude route, zodat beide op dezelfde regels en onder dezelfde
 * omstandigheden (dezelfde rate limits) gemeten worden.
 */
const NIEUW = {
  PLAN_ROUTE: process.env.PLAN_ROUTE || 'parallel',
  PLAN_SCHETS_MODEL: process.env.PLAN_SCHETS_MODEL ?? 'claude-sonnet-5',
  CHARMAP_MODEL: process.env.CHARMAP_MODEL ?? '',
};
const OUD = { PLAN_ROUTE: 'enkel', PLAN_SCHETS_MODEL: '', CHARMAP_MODEL: '' };
const zetRoute = (r: Record<string, string>) => {
  for (const [k, v] of Object.entries(r)) process.env[k] = v;
};

const oordeelSchema = z.object({
  a: z.object({ hook: z.number().min(1).max(10), verhaal: z.number().min(1).max(10), einde: z.number().min(1).max(10), lengte: z.number().min(1).max(10), totaal: z.number().min(1).max(10) }),
  b: z.object({ hook: z.number().min(1).max(10), verhaal: z.number().min(1).max(10), einde: z.number().min(1).max(10), lengte: z.number().min(1).max(10), totaal: z.number().min(1).max(10) }),
  voorkeur: z.enum(['A', 'B', 'gelijk']),
  waarom: z.string(),
});

function brontijden(c: Clip): string {
  return c.shots.map((s) => `${Math.round(s.start)}–${Math.round(s.end)}`).join(', ');
}

/** Overlap in brontijd tussen twee clips, als fractie van de kortste. */
function overlap(a: Clip, b: Clip): number {
  let o = 0;
  for (const x of a.shots) for (const y of b.shots) o += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return o / Math.max(0.1, Math.min(clipDuur(a), clipDuur(b)));
}
const midden = (c: Clip) => c.shots.reduce((t, s) => t + (s.start + s.end) / 2, 0) / Math.max(1, c.shots.length);

function voorBeoordeling(c: Clip): string {
  return JSON.stringify({
    duur_seconden: Math.round(clipDuur(c)),
    hook_overlay: c.hook.tekst_overlay,
    wat_je_hoort: c.shots.map((s) => s.transcript_fragment).join(' '),
    kaarten: (c.kaarten ?? []).map((k) => k.tekst),
  });
}

async function beoordeel(a: Clip, b: Clip, formaat: Formaat): Promise<z.infer<typeof oordeelSchema>> {
  return structuredCall({
    system: `Je beoordeelt twee short-form clips (TikTok/Reels/Shorts, format ${formaat}) die uit dezelfde bronvideo zijn gemaakt. Je weet niet hoe ze gemaakt zijn. Beoordeel elk op: hook (stopt de duim in de eerste 2 s?), verhaal (is er een boog met een omslag, één verhaal, geen vulling?), einde (eindigt hij op een moment — punchline, onthulling, sterke uitspraak — en niet op een samenvatting of afsluiter?), lengte (strak voor dit format, niets te veel, niets te weinig), en een totaalscore. 1–10, wees streng: 8+ is zeldzaam. Kies daarna welke je zou posten.`,
    user: `CLIP A:\n${voorBeoordeling(a)}\n\nCLIP B:\n${voorBeoordeling(b)}`,
    schema: oordeelSchema,
    toolName: 'lever_oordeel',
    toolDescription: 'Lever de scores voor A en B en je voorkeur.',
    maxTokens: 4000,
    effort: 'medium',
    operation: 'ab_beoordeling',
  });
}

async function baselineDuur(planId: string, videoId: string, createdAt: string): Promise<{ minuten: number | null; bron: string }> {
  const { data: jobs } = await db()
    .from('ai_jobs')
    .select('gestart_at, klaar_at')
    .eq('soort', 'clip_plan')
    .eq('doel_id', videoId)
    .not('klaar_at', 'is', null)
    .order('klaar_at', { ascending: false })
    .limit(5);
  const t = new Date(createdAt).getTime();
  const job = (jobs ?? []).find((j) => j.gestart_at && Math.abs(new Date(j.klaar_at as string).getTime() - t) < 10 * 60_000);
  if (job) return { minuten: Math.round(((new Date(job.klaar_at as string).getTime() - new Date(job.gestart_at as string).getTime()) / 60_000) * 10) / 10, bron: 'ai_jobs' };
  void planId;
  const handmatig = process.env[`AB_BASELINE_MIN_${videoId.slice(0, 8)}`];
  return handmatig ? { minuten: Number(handmatig), bron: 'handmatig gemeten (lokale run)' } : { minuten: null, bron: 'onbekend' };
}

async function eenVideo(videoId: string): Promise<string> {
  const supabase = db();
  const { data: video, error } = await supabase.from('videos').select('*, campaigns(name, platform_rules, theme)').eq('id', videoId).single();
  if (error || !video) throw new Error(`video ${videoId} niet gevonden`);
  const campaign = video.campaigns as { name?: string | null; platform_rules?: unknown; theme?: string | null } | null;
  const transcript = video.transcript as TranscriptSegment[];
  const durationSeconds = video.duration_seconds ?? Math.round(transcriptDuration(transcript));
  const vault = await loadVault({ theme: campaign?.theme ?? null });
  const formaat = formaatVoorThema(vault.theme, `${campaign?.name ?? ''} ${video.title}`);

  if (!video.character_map) throw new Error('geen gecachte character map');
  const invoer = {
    title: video.title,
    durationSeconds,
    transcript,
    campaignRules: campaign?.platform_rules ?? {},
    campaignName: campaign?.name ?? null,
    vault,
    characterMap: video.character_map as CharacterMap,
    energie: (video.energie_momenten as Energiemoment[] | null) ?? [],
    bronWoorden: await bronWoordenUitCache(videoId).catch(() => null),
    bronPad: lokaleBron(videoId, video.source_url ?? null),
  };

  // Baseline: een plan met precies deze promptversie uit clip_plans, of zelf
  // draaien met de oude route (niet opslaan).
  const { data: basisRij } = await supabase
    .from('clip_plans')
    .select('id, created_at, prompt_version, plan')
    .eq('video_id', videoId)
    .like('prompt_version', `%${PROMPT_VERSION_PLAN}`)
    .order('created_at', { ascending: false })
    .limit(1);
  let basisPlan: ClipPlan;
  let basisDuur: { minuten: number | null; bron: string };
  let basisTijden: typeof laatstePlannerTijden = null;
  if (basisRij?.[0] && process.env.AB_BASELINE !== 'draai') {
    basisPlan = basisRij[0].plan as ClipPlan;
    basisDuur = await baselineDuur(basisRij[0].id, videoId, basisRij[0].created_at);
    console.log(`baseline uit clip_plans (${basisRij[0].prompt_version})`);
  } else {
    console.log(`baseline zelf draaien (oude route, ${PROMPT_VERSION_PLAN}, niet opgeslagen)…`);
    zetRoute(OUD);
    const tb = Date.now();
    basisPlan = await generateClipPlan(invoer);
    basisDuur = { minuten: Math.round(((Date.now() - tb) / 60_000) * 10) / 10, bron: 'zelf gedraaid in deze run' };
    basisTijden = laatstePlannerTijden;
  }

  // De nieuwe route, met dezelfde gecachte character map.
  zetRoute(NIEUW);
  const t0 = Date.now();
  const nieuw = await generateClipPlan(invoer);
  const nieuwMin = Math.round(((Date.now() - t0) / 60_000) * 10) / 10;
  const tijden = laatstePlannerTijden;

  // Paren: per nieuwe clip de baseline-clip met de meeste brontijd-overlap,
  // anders de dichtstbijzijnde.
  const paren = nieuw.clips.map((n) => {
    const scores = basisPlan.clips.map((b) => ({ b, o: overlap(n, b), afstand: Math.abs(midden(n) - midden(b)) }));
    const beste = scores.sort((x, y) => y.o - x.o || x.afstand - y.afstand)[0];
    return { n, b: beste?.b ?? null, overlap: beste?.o ?? 0 };
  });
  const oordelen: { nieuw: number; basis: number; voorkeur: 'nieuw' | 'basis' | 'gelijk'; waarom: string }[] = [];
  for (const p of paren) {
    if (!p.b) continue;
    const nieuwIsA = Math.random() < 0.5;
    const [a, b] = nieuwIsA ? [p.n, p.b] : [p.b, p.n];
    try {
      const o = await beoordeel(a, b, formaat);
      const nScore = nieuwIsA ? o.a.totaal : o.b.totaal;
      const bScore = nieuwIsA ? o.b.totaal : o.a.totaal;
      const voorkeur = o.voorkeur === 'gelijk' ? 'gelijk' : (o.voorkeur === 'A') === nieuwIsA ? 'nieuw' : 'basis';
      oordelen.push({ nieuw: nScore, basis: bScore, voorkeur, waarom: o.waarom });
    } catch (e) {
      console.warn(`beoordeling mislukt: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  const overtr = (plan: ClipPlan) => plan.clips.reduce((t, c) => t + regelOvertredingen(c, formaat).length, 0);
  const gem = (xs: number[]) => (xs.length ? Math.round((xs.reduce((t, x) => t + x, 0) / xs.length) * 100) / 100 : NaN);
  const gemNieuw = gem(oordelen.map((o) => o.nieuw));
  const gemBasis = gem(oordelen.map((o) => o.basis));
  const ovNieuw = overtr(nieuw);
  const ovBasis = overtr(basisPlan);
  const nietSlechter = ovNieuw <= ovBasis && gemNieuw >= gemBasis - 0.3;

  const regel = (c: Clip) => {
    const zs = c.shots.flatMap((s) => zinnen(s.transcript_fragment ?? ''));
    return `${Math.round(clipDuur(c))} s, score ${c.score} — "${c.titel_intern}" — begint "${(zs[0] ?? '').slice(0, 60)}" — eindigt "${(zs[zs.length - 1] ?? '').slice(0, 60)}" — bron ${brontijden(c)}`;
  };
  const md = `## ${video.title} (${videoId.slice(0, 8)}, format ${formaat})

| | baseline (${PROMPT_VERSION_PLAN}, één examen-call) | nieuw (selectie + ${tijden?.uitschrijvenAantal ?? '?'}× parallel) |
|---|---|---|
| (a) duur plan | ${basisDuur.minuten ?? '?'} min (${basisDuur.bron}) | ${nieuwMin} min |
| (b) aantal clips | ${basisPlan.clips.length} | ${nieuw.clips.length} |
| (b) momenten met overlap ≥ 50% met de baseline | — | ${paren.filter((p) => p.overlap >= 0.5).length}/${paren.length} |
| (c) regelovertredingen (lengte, einde, opening, twee verhalen) | ${ovBasis} | ${ovNieuw} |
| (d) blinde beoordeling, gemiddeld totaal | ${gemBasis} | ${gemNieuw} |
| (d) voorkeur | ${oordelen.filter((o) => o.voorkeur === 'basis').length} | ${oordelen.filter((o) => o.voorkeur === 'nieuw').length} (gelijk ${oordelen.filter((o) => o.voorkeur === 'gelijk').length}) |

Route nieuw: ${NIEUW.PLAN_ROUTE}, schets ${NIEUW.PLAN_SCHETS_MODEL || 'hoofdmodel'}; promptversie ${PROMPT_VERSION_PLAN}.
Tijd per stap (baseline): ${basisTijden ? `schets ${Math.round(basisTijden.schets)} s, examen ${Math.round(basisTijden.uitschrijven)} s, verhaaldokter ${Math.round(basisTijden.verhaaldokter)} s` : '(uit clip_plans)'}
Tijd per stap (nieuw): ${tijden ? `schets ${Math.round(tijden.schets)} s, signalen ${Math.round(tijden.signalen)} s, selectie ${Math.round(tijden.selectie ?? 0)} s, uitschrijven ${Math.round(tijden.uitschrijven)} s, verhaaldokter ${Math.round(tijden.verhaaldokter)} s` : '?'}

**Oordeel: ${nietSlechter ? 'niet slechter' : 'SLECHTER'}** (eis: overtredingen ≤ baseline én beoordeling ≥ baseline − 0,3).

Baseline-clips:
${basisPlan.clips.map((c, i) => `${i + 1}. ${regel(c)}`).join('\n')}

Nieuwe clips (met de gepaarde baseline-clip en de overlap):
${paren.map((p, i) => `${i + 1}. ${regel(p.n)} — paar: "${p.b?.titel_intern ?? '—'}" (overlap ${Math.round(p.overlap * 100)}%)${oordelen[i] ? ` — beoordeling nieuw ${oordelen[i].nieuw} / baseline ${oordelen[i].basis}, voorkeur ${oordelen[i].voorkeur}: ${oordelen[i].waarom.slice(0, 160)}` : ''}`).join('\n')}

Overtredingen nieuw: ${nieuw.clips.flatMap((c) => regelOvertredingen(c, formaat).map((o) => `"${c.titel_intern}": ${o}`)).join('; ') || 'geen'}
Overtredingen baseline: ${basisPlan.clips.flatMap((c) => regelOvertredingen(c, formaat).map((o) => `"${c.titel_intern}": ${o}`)).join('; ') || 'geen'}
`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const uit = { videoId, formaat, baseline: { plan: basisPlan, duur: basisDuur, tijden: basisTijden, overtredingen: ovBasis }, nieuw: { plan: nieuw, minuten: nieuwMin, tijden, overtredingen: ovNieuw }, oordelen, gemNieuw, gemBasis, nietSlechter };
  mkdirSync(join('scripts', 'ab'), { recursive: true });
  writeFileSync(join('scripts', 'ab', `${videoId}.json`), JSON.stringify(uit, null, 1));
  writeFileSync(join('scripts', 'ab', `${videoId}.md`), md);
  const up = await r2Upload(`ab/${videoId}/${ts}.json`, Buffer.from(JSON.stringify(uit)), 'application/json');
  if (up.error) console.warn(`R2-upload mislukt: ${up.error.message}`);
  return md;
}

(async () => {
  const ids = process.argv.slice(2);
  if (!ids.length) throw new Error('geef een of meer video-id’s');
  const delen: string[] = [];
  for (const id of ids) {
    try {
      delen.push(await eenVideo(id));
    } catch (e) {
      delen.push(`## ${id}\n\nMISLUKT: ${(e as Error).message}\n`);
    }
    console.log(delen[delen.length - 1]);
  }
  writeFileSync(join('scripts', 'ab', 'uitslag.md'), delen.join('\n'));
})();
