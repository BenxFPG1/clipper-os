import { spawnSync } from 'node:child_process';

/**
 * Welke python heeft OpenCV én numpy? Op een machine met meerdere
 * installaties wees `python3` niet per se naar dezelfde als waar pip in
 * installeerde, en dan viel de sprekerdetectie stil terug op het midden zonder
 * dat iemand het merkte.
 */
let pythonKeuze: { cmd: string; voor: string[] } | null = null;
export function pythonMetOpenCV(): { cmd: string; voor: string[] } {
  if (pythonKeuze) return pythonKeuze;

  const binaries = [process.env.PYTHON_BIN, 'python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3', 'python']
    .filter(Boolean) as string[];

  const kandidaten: { cmd: string; voor: string[] }[] = [];
  for (const bin of binaries) {
    kandidaten.push({ cmd: bin, voor: [] });
    // Draait Node onder Rosetta (x86_64) op een Apple Silicon-Mac, dan erft de
    // python die hij start diezelfde architectuur en weigert numpy te laden —
    // dat is arm64. `arch -arm64` zet dat recht. Op andere machines bestaat het
    // commando niet of faalt de proef, en dan valt hij gewoon door.
    if (process.platform === 'darwin') kandidaten.push({ cmd: 'arch', voor: ['-arm64', bin] });
  }

  for (const kandidaat of kandidaten) {
    const proef = spawnSync(kandidaat.cmd, [...kandidaat.voor, '-c', 'import cv2, numpy'], { stdio: 'ignore' });
    if (proef.status === 0) {
      pythonKeuze = kandidaat;
      return kandidaat;
    }
  }
  pythonKeuze = { cmd: 'python3', voor: [] };
  return pythonKeuze;
}
