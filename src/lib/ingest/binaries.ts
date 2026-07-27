import { existsSync } from 'node:fs';

/**
 * Zoekt een binary op de gebruikelijke Homebrew- en systeempaden. Nodig omdat
 * het serverproces (afhankelijk van hoe het gestart is) niet altijd dezelfde
 * PATH heeft als je shell — dan bestaat yt-dlp wel, maar vindt spawn hem niet.
 */
const CANDIDATE_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];

const cache = new Map<string, string>();

export function resolveBinary(name: string): string {
  const hit = cache.get(name);
  if (hit) return hit;

  for (const dir of CANDIDATE_DIRS) {
    const full = `${dir}/${name}`;
    if (existsSync(full)) {
      cache.set(name, full);
      return full;
    }
  }

  // Val terug op de kale naam; als PATH hem wel kent werkt dit alsnog.
  cache.set(name, name);
  return name;
}
