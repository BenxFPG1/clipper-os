import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveBinary } from '../ingest/binaries';
import { tekenHookKaart, kaartenMap, type Huisstijl } from '../roughcut/tekstkaarten';
import { zorgVoorMuziekbed } from '../muziek';
import { downloadBroll } from './ingest';
import type { BrollClip } from './plan';

/**
 * De b-roll-render: meerdere bronbestanden, geen spraak.
 *
 * Bewust een eigen, kleine assembler naast maakRuweMontage in plaats van die
 * uit te breiden: de spraak-render is de meest kwetsbare kern van dit systeem
 * (woordankers, poort, scriptcontrole — allemaal irrelevant zonder spraak) en
 * elke wijziging daar heeft eerder iets anders gesloopt. Wat hier wél uit die
 * keten hergebruikt wordt: de tekstkaarten (huisstijl), het muziekbed en de
 * emotiecurve-ducking-gedachte — maar dan omgekeerd: muziek ís hier de
 * hoofdband, en zwelt juist óp naar de spanningspiek.
 */

export async function maakBrollMontage(opties: {
  clip: BrollClip;
  /** video_id → opslagpad (storage:broll/...). */
  bronnen: Map<string, string>;
  werkmap: string;
  outputPad: string;
  huisstijl?: Huisstijl | null;
  log?: (m: string) => void;
}): Promise<void> {
  const log = opties.log ?? (() => undefined);
  const { clip } = opties;
  const shots = [...clip.shots].sort((a, b) => a.volgorde - b.volgorde);

  // Bronnen ophalen (één keer per uniek bestand).
  const bronMap = join(opties.werkmap, 'broll-bronnen');
  await mkdir(bronMap, { recursive: true });
  const lokaal = new Map<string, string>();
  for (const videoId of new Set(shots.map((s) => s.video_id))) {
    const opslagPad = opties.bronnen.get(videoId);
    if (!opslagPad) throw new Error(`geen bronpad voor video ${videoId}`);
    const pad = join(bronMap, `${videoId}.mp4`);
    if (!existsSync(pad)) {
      log(`bron ophalen: ${opslagPad.slice(-50)}`);
      await downloadBroll(opslagPad, pad);
    }
    lokaal.set(videoId, pad);
  }

  const totaleDuur = shots.reduce((t, s) => t + (s.end - s.start), 0);

  // Muziek: de hoofdband van een b-roll-edit. Het bed zwelt op met de
  // spanningscurve (0,55 rustig → 0,85 op de piek) in plaats van te duiken
  // onder spraak die er niet is.
  const muziekPad = await zorgVoorMuziekbed(clip.muziek || 'energiek', {
    werkmap: opties.werkmap,
    seconden: totaleDuur,
    beschrijving: clip.titel_intern,
    log,
  });

  // Hook-overlay als PNG in de huisstijl, over de eerste 2,4 seconden.
  let hookPng: string | null = null;
  if (clip.hook_overlay) {
    const map = await kaartenMap(opties.werkmap);
    hookPng = join(map, 'broll-hook.png');
    await tekenHookKaart(clip.hook_overlay, hookPng, opties.huisstijl ?? null);
  }
  // Losse overlay-teksten per shot, zelfde stijl.
  const overlayPngs: (string | null)[] = [];
  {
    const map = await kaartenMap(opties.werkmap);
    for (const [i, sh] of shots.entries()) {
      if (sh.overlay_tekst) {
        const pad = join(map, `broll-ov-${i}.png`);
        await tekenHookKaart(sh.overlay_tekst, pad, opties.huisstijl ?? null);
        overlayPngs.push(pad);
      } else {
        overlayPngs.push(null);
      }
    }
  }

  // ffmpeg-opbouw: per shot een input (-ss/-t), 9:16 center-crop, concat.
  const args: string[] = ['-nostdin', '-y'];
  for (const sh of shots) {
    args.push('-ss', sh.start.toFixed(3), '-t', (sh.end - sh.start).toFixed(3), '-i', lokaal.get(sh.video_id)!);
  }
  const bedDuurRondes = 3; // ruim; wordt afgekapt op totaleDuur
  const heeftMuziek = muziekPad && existsSync(muziekPad);
  if (heeftMuziek) args.push('-stream_loop', String(bedDuurRondes), '-i', muziekPad!);
  const pngStart = shots.length + (heeftMuziek ? 1 : 0);
  if (hookPng) args.push('-i', hookPng);
  for (const png of overlayPngs) if (png) args.push('-i', png);

  let filter = '';
  const vLabels: string[] = [];
  for (const [i] of shots.entries()) {
    // Landscape → staand: schalen tot de hoogte en het midden uitsnijden.
    filter +=
      `[${i}:v]setpts=PTS-STARTPTS,fps=30,scale=-2:1920,crop=1080:1920:(iw-1080)/2:(ih-1920)/2,` +
      `format=yuv420p,setsar=1[v${i}];`;
    vLabels.push(`[v${i}]`);
  }
  filter += `${vLabels.join('')}concat=n=${shots.length}:v=1:a=0[vconcat]`;

  // Overlays: hook over 0-2,4s, shot-overlays over hun eigen venster.
  let videoUit = 'vconcat';
  let pngIndex = pngStart;
  if (hookPng) {
    filter += `;[${videoUit}][${pngIndex}:v]overlay=0:0:enable='between(t,0,2.4)'[vhook]`;
    videoUit = 'vhook';
    pngIndex++;
  }
  {
    let cursor = 0;
    for (const [i, sh] of shots.entries()) {
      const duur = sh.end - sh.start;
      if (overlayPngs[i]) {
        // Niet tegelijk met de hook: een shot-overlay in de eerste seconden
        // schuift op tot na de hookkaart.
        const van = Math.max(cursor + 0.1, i === 0 ? 2.5 : cursor + 0.1);
        const tot = Math.min(cursor + duur, van + Math.max(1.6, duur - 0.2));
        filter += `;[${videoUit}][${pngIndex}:v]overlay=0:0:enable='between(t,${van.toFixed(2)},${tot.toFixed(2)})'[vo${i}]`;
        videoUit = `vo${i}`;
        pngIndex++;
      }
      cursor += duur;
    }
  }

  // Audio: alleen het muziekbed, opzwellend met de spanningscurve.
  if (heeftMuziek) {
    const volExpr = shots
      .reduceRight<{ expr: string; cursor: number }>(
        (acc, sh) => {
          const duur = sh.end - sh.start;
          const van = acc.cursor - duur;
          const vol = 0.55 + ((Math.min(10, Math.max(1, sh.spanning)) - 1) / 9) * 0.3;
          return {
            expr: `if(between(t\\,${van.toFixed(2)}\\,${acc.cursor.toFixed(2)})\\,${vol.toFixed(2)}\\,${acc.expr})`,
            cursor: van,
          };
        },
        { expr: '0.55', cursor: totaleDuur },
      ).expr;
    filter +=
      `;[${shots.length}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
      `atrim=0:${totaleDuur.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=0.6,afade=t=out:st=${Math.max(0, totaleDuur - 1.0).toFixed(3)}:d=1.0,` +
      `volume='${volExpr}':eval=frame,` +
      `loudnorm=I=-14:TP=-1.5[amuz]`;
  }

  args.push('-filter_complex', filter, '-map', `[${videoUit}]`);
  if (heeftMuziek) args.push('-map', '[amuz]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
  if (heeftMuziek) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  args.push('-movflags', '+faststart', opties.outputPad);

  log(`monteren: ${shots.length} shots uit ${lokaal.size} bestanden, ${totaleDuur.toFixed(1)}s`);
  await new Promise<void>((klaar, fout) => {
    const kind = spawn(resolveBinary('ffmpeg'), args);
    let stderr = '';
    kind.stderr.on('data', (d) => (stderr += d));
    kind.on('error', fout);
    kind.on('close', (code) => (code === 0 ? klaar() : fout(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`))));
  });
  if (!existsSync(opties.outputPad)) throw new Error('render leverde geen bestand op');
}
