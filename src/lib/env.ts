export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Ontbrekende env var: ${name}`);
  return value;
}

export function optionalEnv(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

export const CLAUDE_MODEL = optionalEnv('CLAUDE_MODEL', 'claude-opus-5');
export const COST_ALERT_EUR = Number(optionalEnv('COST_ALERT_EUR', '20'));

/**
 * Hoeveel denkwerk het model per stap mag doen. Hoger betekent betere plannen,
 * maar ook langer wachten en meer kosten: op een video van 39 minuten scheelt
 * xhigh tegenover high ongeveer een factor twee in doorlooptijd.
 */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

function effortFromEnv(name: string, fallback: Effort): Effort {
  const value = optionalEnv(name) as Effort;
  return EFFORTS.includes(value) ? value : fallback;
}

export const CHARMAP_EFFORT = effortFromEnv('CHARMAP_EFFORT', 'high');
export const PLAN_EFFORT = effortFromEnv('PLAN_EFFORT', 'xhigh');
export const SCRIPT_EFFORT = effortFromEnv('SCRIPT_EFFORT', 'xhigh');
export const AGENT_EFFORT = effortFromEnv('AGENT_EFFORT', 'high');
