import { spawn } from 'node:child_process';
import { instelling } from './instellingen';
import type { Shot } from './index';
import type { KeuringRegel } from './keuring';

/**
 * Scherp begin: het eerste frame van een clip beslist of iemand blijft
 * kijken. Een wazige arm, een rug of een camerazwiep als eerste beeld leest
 * als amateur (MUKBANG clip 4 opende zo). Hier:
 *
 *  - meten: scherpte (Laplacian-variantie) van het beeld en van het grootste
 *    gezicht, via gezichten.py --scherpte;
 *  - beslissen: is het begin bruikbaar? Zo niet, het dichtstbijzijnde moment
 *    in het eerste shot met een scherp gezicht als kaderreferentie, en —
 *    als dat binnen SCHERP_BEVRIES_MAX ligt — het beeld tot daar vervangen
 *    door dat frame (bevroren; het geluid loopt door);
 *  - keuren: "scherp begin" op het eindbestand.
 */

export type ScherpteMeting = {
  t: number;
  beeld: number;
  gezicht: { x: number; breedte: number; scherpte: number } | null;
} | null;

export type ScherpteMeter = (tijden: number[]) => Promise<ScherpteMeting[]>;

export function scherpteMeterVia(bron: string, py: { cmd: string; voor: string[] }): ScherpteMeter {
  return (tijden) =>
    new Promise((klaar) => {
      const kind = spawn(py.cmd, [...py.voor, 'scripts/gezichten.py', bron, '--scherpte', JSON.stringify(tijden)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      kind.stdout.on('data', (d) => (stdout += d));
      kind.on('error', () => klaar(tijden.map(() => null)));
      kind.on('close', () => {
        try {
          const regel = stdout.split('\n').map((r) => r.trim()).reverse().find((r) => r.startsWith('['));
          const m = JSON.parse(regel || '[]') as ScherpteMeting[];
          klaar(m.length === tijden.length ? m : tijden.map(() => null));
        } catch {
          klaar(tijden.map(() => null));
        }
      });
    });
}

/** Een scherp, duidelijk gezicht in een beeld zonder zwiep. */
export function bruikbaar(m: ScherpteMeting): boolean {
  return Boolean(
    m &&
      m.beeld >= instelling('SCHERP_MIN_BEELD') &&
      m.gezicht &&
      m.gezicht.breedte >= instelling('SCENE_MIN_GEZICHT') &&
      m.gezicht.scherpte >= instelling('SCHERP_MIN_GEZICHT'),
  );
}

export type ScherpBeginBesluit =
  | { status: 'ok' | 'graphic' | 'geen_scherp_gezicht'; detail: string }
  | { status: 'bevries' | 'referentie'; t: number; gezicht: { x: number; breedte: number }; detail: string };

/**
 * Beslist over het begin van het eerste shot. `metingen` horen bij
 * `tijden` (oplopend, vanaf het begin van het shot).
 */
export function besluitScherpBegin(eerste: Shot, tijden: number[], metingen: ScherpteMeting[]): ScherpBeginBesluit {
  const begin = metingen[0];
  if (bruikbaar(begin)) return { status: 'ok', detail: `begin scherp (gezicht ${begin!.gezicht!.scherpte.toFixed(0)}, beeld ${begin!.beeld.toFixed(0)})` };
  const i = metingen.findIndex(bruikbaar);
  const waarom = !begin ? 'niet gemeten' : !begin.gezicht ? 'geen gezicht' : begin.beeld < instelling('SCHERP_MIN_BEELD') ? `beeld onscherp (${begin.beeld.toFixed(0)})` : `gezicht onscherp (${begin.gezicht.scherpte.toFixed(0)})`;
  if (i < 0) return { status: 'geen_scherp_gezicht', detail: `begin: ${waarom}; geen scherp gezicht in de eerste ${(tijden[tijden.length - 1] - eerste.start).toFixed(1)} s` };
  const m = metingen[i]!;
  const na = tijden[i] - eerste.start;
  if (na <= instelling('SCHERP_BEVRIES_MAX') + 1e-6) {
    return { status: 'bevries', t: tijden[i], gezicht: m.gezicht!, detail: `begin: ${waarom} → eerste ${na.toFixed(2)} s bevroren op het scherpe frame van ${tijden[i].toFixed(2)} s (gezicht op ${m.gezicht!.x.toFixed(2)})` };
  }
  return { status: 'referentie', t: tijden[i], gezicht: m.gezicht!, detail: `begin: ${waarom} → kader op het scherpe gezicht van ${tijden[i].toFixed(2)} s (x ${m.gezicht!.x.toFixed(2)}); te laat om te bevriezen` };
}

/**
 * Past het besluit toe op het eerste shot: kaderreferentie (focus of het
 * begin van het spoor op het scherpe gezicht) en eventueel het bevroren begin.
 */
export function pasScherpBeginToe(eerste: Shot, besluit: ScherpBeginBesluit): void {
  if (besluit.status !== 'bevries' && besluit.status !== 'referentie') return;
  const x = besluit.gezicht.x;
  if (eerste.spoor?.length) {
    // Tot het scherpe moment staat het kader op dat gezicht.
    eerste.spoor = [{ t: eerste.start, x }, ...eerste.spoor.filter((p) => p.t >= besluit.t)];
    if (!eerste.spoor.some((p) => Math.abs(p.t - besluit.t) < 0.05)) eerste.spoor.push({ t: besluit.t, x });
    eerste.spoor.sort((a, b) => a.t - b.t);
  } else if (eerste.focusX === undefined || Math.abs(eerste.focusX - x) > 0.08) {
    eerste.focusX = x;
  }
  if (besluit.status === 'bevries') {
    eerste.bevriesBegin = { tot: Math.round((besluit.t - eerste.start) * 1000) / 1000, bron: besluit.t };
  } else {
    eerste.bevriesBegin = undefined;
  }
}

/** Keuring op het eindbestand: toont het eerste frame een scherp gezicht (of een graphic)? */
export async function keurScherpBegin(montagePad: string, eerste: Shot | undefined, meter: ScherpteMeter): Promise<KeuringRegel> {
  const naam = 'scherp begin';
  if (!eerste) return { naam, goed: null, detail: 'geen shots' };
  if (eerste.beeldtype === 'graphic' || eerste.scenes?.find((s) => s.van <= eerste.start + 0.05)?.gezicht === false) {
    return { naam, goed: true, detail: 'clip opent op een graphic' };
  }
  const [m] = await meter([0.04]);
  void montagePad;
  if (!m) return { naam, goed: null, detail: 'niet te meten' };
  // In het staande eindbeeld is het gezicht groter; de gezichtsscherpte is
  // op een vaste maat gemeten en dus vergelijkbaar.
  if (m.gezicht && m.gezicht.scherpte >= instelling('SCHERP_MIN_GEZICHT')) {
    return { naam, goed: true, detail: `eerste frame: scherp gezicht (${m.gezicht.scherpte.toFixed(0)})${eerste.bevriesBegin ? `, ${eerste.bevriesBegin.tot.toFixed(2)} s bevroren` : ''}` };
  }
  return {
    naam,
    goed: false,
    detail: m.gezicht ? `eerste frame: gezicht onscherp (${m.gezicht.scherpte.toFixed(0)} < ${instelling('SCHERP_MIN_GEZICHT')})` : 'eerste frame: geen gezicht',
  };
}
