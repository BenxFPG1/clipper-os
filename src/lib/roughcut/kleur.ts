import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { instelling } from './instellingen';
import { filterPad } from './ondertitels';

/**
 * Lichte, automatische kleurcorrectie per bron.
 *
 * Bronnen verschillen: de ene podcast is onderbelicht, de andere flets. Een
 * clip die naast professionele content in de feed staat, valt daar direct op
 * als "amateur". Hier geen creatieve grading, alleen normaliseren: de
 * gemiddelde helderheid richting KLEUR_DOEL_YAVG, het contrast iets op als de
 * bron vlak is, een fractie meer verzadiging — en nooit zo ver dat licht of
 * donker gaat clippen: de gemeten uitersten blijven binnen het bereik.
 * Optioneel daarna een LUT per campagne (assets/lut/<naam>.cube).
 */

export type KleurMeting = { yavg: number; ylow: number; yhigh: number; satavg: number; frames: number };

/** Helderheid en verzadiging op een paar momenten (signalstats; 8-bit, 0–255). */
export async function meetKleur(bron: string, tijden: number[]): Promise<KleurMeting | null> {
  const metingen: KleurMeting[] = [];
  for (const t of tijden) {
    const uit = await new Promise<string>((klaar) => {
      const kind = spawn(
        resolveBinary('ffmpeg'),
        ['-nostdin', '-hide_banner', '-ss', Math.max(0, t).toFixed(2), '-i', bron, '-frames:v', '1', '-vf', 'scale=320:-2,format=yuv420p,signalstats,metadata=print', '-f', 'null', '-'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let alles = '';
      kind.stdout.on('data', (d) => (alles += d));
      kind.stderr.on('data', (d) => (alles += d));
      kind.on('error', () => klaar(''));
      kind.on('close', () => klaar(alles));
    });
    const lees = (k: string) => Number(uit.match(new RegExp(`lavfi\\.signalstats\\.${k}=([\\d.]+)`))?.[1]);
    const m = { yavg: lees('YAVG'), ylow: lees('YLOW'), yhigh: lees('YHIGH'), satavg: lees('SATAVG'), frames: 1 };
    if ([m.yavg, m.ylow, m.yhigh].every(Number.isFinite)) metingen.push(m);
  }
  if (metingen.length === 0) return null;
  const gem = (k: keyof KleurMeting) => metingen.reduce((a, m) => a + m[k], 0) / metingen.length;
  return {
    yavg: gem('yavg'),
    ylow: Math.min(...metingen.map((m) => m.ylow)),
    yhigh: Math.max(...metingen.map((m) => m.yhigh)),
    satavg: gem('satavg'),
    frames: metingen.length,
  };
}

export type KleurCorrectie = { filter: string | null; contrast: number; helderheid: number; verzadiging: number; lut: string | null; detail: string };

/**
 * De correctie voor deze meting. eq werkt (voor helderheid en contrast) als
 * Y' = (Y − 128)·contrast + 128 + helderheid·255; contrast en helderheid
 * worden zo gekozen dat YLOW en YHIGH van de bron binnen 16–240 blijven.
 */
export function kleurCorrectie(m: KleurMeting | null, opties: { lut?: string | null } = {}): KleurCorrectie {
  const lutPad = opties.lut ? join(process.cwd(), 'assets', 'lut', `${opties.lut}.cube`) : null;
  const lut = lutPad && existsSync(lutPad) ? lutPad : null;
  if (!m) {
    return { filter: lut ? `lut3d=file=${filterPad(lut)}` : null, contrast: 1, helderheid: 0, verzadiging: 1, lut, detail: 'niet gemeten' };
  }
  const bereik = Math.max(1, m.yhigh - m.ylow);
  // Contrast: alleen omhoog als de bron vlak is, en nooit zo dat de uitersten clippen.
  let contrast = Math.min(instelling('KLEUR_MAX_CONTRAST'), Math.max(1, 200 / bereik));
  const ruimteBoven = (240 - 128) / Math.max(1, m.yhigh - 128);
  const ruimteOnder = (128 - 16) / Math.max(1, 128 - m.ylow);
  contrast = Math.max(1, Math.min(contrast, ruimteBoven, ruimteOnder));
  // Helderheid: het gemiddelde richting het doel, binnen wat de uitersten toelaten.
  const naContrast = (y: number) => (y - 128) * contrast + 128;
  let schuif = instelling('KLEUR_DOEL_YAVG') - naContrast(m.yavg);
  schuif = Math.min(schuif, 240 - naContrast(m.yhigh));
  schuif = Math.max(schuif, 16 - naContrast(m.ylow));
  schuif = Math.max(-18, Math.min(18, schuif));
  const helderheid = Math.round((schuif / 255) * 1000) / 1000;
  const verzadiging = instelling('KLEUR_VERZADIGING');
  const eq = `eq=contrast=${contrast.toFixed(3)}:brightness=${helderheid.toFixed(3)}:saturation=${verzadiging.toFixed(3)}`;
  const filter = lut ? `${eq},lut3d=file=${filterPad(lut)}` : eq;
  const verwacht = naContrast(m.yavg) + schuif;
  return {
    filter,
    contrast,
    helderheid,
    verzadiging,
    lut,
    detail:
      `helderheid gem. ${Math.round(m.yavg)} → ${Math.round(verwacht)}, contrast ×${contrast.toFixed(2).replace('.', ',')}, ` +
      `verzadiging ×${verzadiging.toFixed(2).replace('.', ',')}, bereik ${Math.round(m.ylow)}–${Math.round(m.yhigh)} → ` +
      `${Math.round(naContrast(m.ylow) + schuif)}–${Math.round(naContrast(m.yhigh) + schuif)}${lut ? `, LUT ${opties.lut}` : ''}`,
  };
}
