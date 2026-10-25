/**
 * Tests voor stream-overlays (src/lib/roughcut/streamoverlay.ts en
 * gezichten.py --overlays): het kader wijkt opzij of zoomt iets in voor een
 * chatvenster zonder de spreker uit het midden te halen, het zoomplafond op
 * een 1080p-bron, en de herkenning op synthetische video — vaste tekst in de
 * hoek van een bewegend beeld wel, een stilstaand studiobeeld niet.
 *
 * Draaien: npm run test:streamoverlay
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../src/lib/ingest/binaries';
import { pythonMetOpenCV } from '../src/lib/python';
import type { Shot } from '../src/lib/roughcut';
import { basisZoom } from '../src/lib/roughcut';
import { uitsnedeVan } from '../src/lib/roughcut/kadercontrole';
import { begrensOpschaal, keurStreamOverlay, meetStreamOverlays, overlapt, wijkVoorOverlays, zoomPlafond } from '../src/lib/roughcut/streamoverlay';

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

// Zoals gemeten op TOTA Clip 2-1: chat linksboven, teller rechtsboven, watermerk onderin.
const CHAT = { x0: 0, y0: 0, x1: 0.188, y1: 0.222 };
const TELLER = { x0: 0.854, y0: 0, x1: 1, y1: 0.111 };
const WATERMERK = { x0: 0.438, y0: 0.889, x1: 0.583, y1: 1 };
const shot = (x: number, top = 0.35, zoom?: number): Shot => {
  const s: Shot = { volgorde: 1, start: 0, end: 4, functie: 'setup', focusX: x, focusY: 0.5, gezicht: { x, breedte: 0.07, top, hoogte: 0.14 } };
  s.zoom = zoom ?? basisZoom(s);
  return s;
};
const u = (s: Shot) => uitsnedeVan(s.focusX ?? 0.5, s.zoom ?? 1, s.focusY ?? 0.5, 16 / 9);
const inBeeld = (s: Shot) => {
  const k = u(s);
  return (s.gezicht!.x - k.x0) / (k.x1 - k.x0);
};

async function main() {
  console.log('kader wijkt voor de chat');
  {
    // Spreker net rechts van de chat: een klein stukje opzij is genoeg.
    const s = shot(0.33);
    toets('vooraf: de chat staat in de uitsnede', overlapt(u(s), CHAT), JSON.stringify(u(s)));
    const r = wijkVoorOverlays([s], [CHAT, TELLER, WATERMERK], 'vullend', { bronHoogte: 2160 });
    toets('opzij geschoven: chat buiten beeld', !overlapt(u(s), CHAT), JSON.stringify({ u: u(s), r }));
    toets('spreker blijft binnen de keuringsmarge (14%)', Math.abs(inBeeld(s) - 0.5) <= 0.14, `${inBeeld(s).toFixed(3)}`);
    toets('niets meer in beeld gemeld', r.nogInBeeld.length === 0, JSON.stringify(r));

    // Spreker recht onder de chat: opzij kan niet; inzoomen tot onder het vak wel (4K).
    const onder = shot(0.15, 0.4);
    const r2 = wijkVoorOverlays([onder], [CHAT], 'vullend', { bronHoogte: 2160 });
    toets('onder de chat: ingezoomd zodat de uitsnede onder het vak valt', !overlapt(u(onder), CHAT) && (onder.zoom ?? 0) > 1, JSON.stringify({ u: u(onder), zoom: onder.zoom, r2 }));
    toets('het hoofd blijft heel in beeld', u(onder).y0 <= onder.gezicht!.top && u(onder).y1 >= onder.gezicht!.top + onder.gezicht!.hoogte);

    // Spreker vlak onder de chat op een 1080p-bron: het plafond verbiedt de
    // benodigde zoom → blijft staan en wordt gemeld (niet half uit beeld).
    const krap = shot(0.12, 0.24);
    const voor = { ...krap };
    const r3 = wijkVoorOverlays([krap], [CHAT], 'vullend', { bronHoogte: 1080 });
    toets('past niet: kader ongemoeid en gemeld', krap.focusX === voor.focusX && krap.zoom === voor.zoom && r3.nogInBeeld.length === 1, JSON.stringify({ krap, r3 }));
    toets('keuring noemt het, maar faalt niet', keurStreamOverlay([CHAT], r3.nogInBeeld).goed === null && /nog in beeld/.test(keurStreamOverlay([CHAT], r3.nogInBeeld).detail));
    toets('zonder overlays geen ingreep', wijkVoorOverlays([shot(0.33)], [], 'vullend').regels.length === 0);
  }

  console.log('zoomplafond op een lage-resolutiebron');
  {
    toets('1080p: plafond ~1,35', Math.abs(zoomPlafond(1080) - 1.35) < 0.01, `${zoomPlafond(1080)}`);
    toets('onbekende hoogte (YouTube, 4K-secties): ZOOM_MAX', zoomPlafond(null) === 1.7);
    const s = shot(0.5, 0.35, 1.7);
    const r = begrensOpschaal([s], 'vullend', 1080);
    toets('zoom 1,70 op 1080p terug naar het plafond', s.zoom === 1.35 && r.length === 1, JSON.stringify({ zoom: s.zoom, r }));
    const v = shot(0.5, 0.35, 1.7);
    begrensOpschaal([v], 'vullend', 2160);
    toets('op 4K blijft zoom 1,70 staan', v.zoom === 1.7);
  }

  console.log('gezichten.py --overlays op synthetische video');
  {
    const ffmpeg = resolveBinary('ffmpeg');
    const py = pythonMetOpenCV();
    const map = mkdtempSync(join(tmpdir(), 'streamoverlay-'));
    try {
      // Bewegend beeld (een schuivende mandelbrot, zoals een handcamera) met
      // vaste tekstregels linksboven.
      const bewegend = join(map, 'stream.mp4');
      const tekst = Array.from({ length: 6 }, (_, i) => `drawbox=x=10:y=${10 + i * 22}:w=180:h=14:color=white@0.9:t=fill,drawbox=x=14:y=${13 + i * 22}:w=${60 + ((i * 37) % 100)}:h=8:color=black:t=fill`).join(',');
      spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=10', '-t', '40', '-vf', `scroll=h=0.004:v=0.002,${tekst}`, '-pix_fmt', 'yuv420p', bewegend]);
      const vakken = meetStreamOverlays(bewegend, py);
      const hoek = vakken.find((v) => v.x0 <= 0.02 && v.y0 <= 0.02);
      toets('vaste tekst linksboven in bewegend beeld → overlay', Boolean(hoek && hoek.x1 >= 0.25 && hoek.x1 <= 0.45 && hoek.y1 >= 0.3 && hoek.y1 <= 0.5), JSON.stringify(vakken));

      // Een (vrijwel) stilstaand beeld met vaste randen overal, zoals een
      // studio: niet van een logo te onderscheiden → niets, zodat er nooit
      // een echt gezicht wegvalt.
      const stil = join(map, 'studio.mp4');
      spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=10:d=40', '-vf', 'drawbox=x=500:y=10:w=120:h=30:color=white:t=fill', '-pix_fmt', 'yuv420p', stil]);
      toets('stilstaand beeld → geen overlays', meetStreamOverlays(stil, py).length === 0, JSON.stringify(meetStreamOverlays(stil, py)));
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  }

  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
