export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Ontbrekende env var: ${name}`);
  return value;
}

export function optionalEnv(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

export const CLAUDE_MODEL = optionalEnv('CLAUDE_MODEL', 'claude-opus-5');
// Voor licht werk (classificatie, import-parsing): telt minder zwaar mee in de
// abonnementslimiet. Het creatieve werk blijft op het hoofdmodel.
export const CLAUDE_LICHT_MODEL = optionalEnv('CLAUDE_LICHT_MODEL', 'claude-sonnet-5');
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
// Was 'xhigh': met het toernooi (brede kandidatenset) is dit al verreweg de
// grootste en langzaamste call van de pijplijn (~100k tokens op een uur
// podcast — meer dan character map en examenpas samen). Het concept hoeft
// niet perfect te zijn, alleen breed: de examen- en verhaaldokterpas bestaan
// juist om te herstellen wat het concept mist. 'high' scheelt ruwweg de helft
// van de doorlooptijd van deze call.
export const PLAN_EFFORT = effortFromEnv('PLAN_EFFORT', 'high');
// De examenpass toetst een bestaand plan tegen vaste kaders; dat vraagt minder
// denkwerk dan het plan bedenken, en scheelt de helft van de wachttijd.
export const PLAN_EXAMEN_EFFORT = effortFromEnv('PLAN_EXAMEN_EFFORT', 'high');
// De verhaaldokter is bewust smal: hij raakt alleen verhaallijn, score en
// welke clips overblijven aan, op een plan dat al door het toernooi is. Dat
// is een begrensde taak, geen open denkwerk — 'medium' volstaat.
export const PLAN_VERHAALDOKTER_EFFORT = effortFromEnv('PLAN_VERHAALDOKTER_EFFORT', 'medium');
export const SCRIPT_EFFORT = effortFromEnv('SCRIPT_EFFORT', 'xhigh');
// Zelfde redenering als bij het plan: de examinator toetst tegen vaste kaders.
export const SCRIPT_EXAMEN_EFFORT = effortFromEnv('SCRIPT_EXAMEN_EFFORT', 'high');
export const AGENT_EFFORT = effortFromEnv('AGENT_EFFORT', 'high');

/**
 * Maximum aantal clips per plan (spec: 10-25). De output-tokens zijn de grootste
 * kostenpost van een plan; minder vulling-clips scheelt direct geld terwijl de
 * topclips onveranderd blijven.
 */
export const PLAN_MAX_CLIPS = Math.min(25, Math.max(10, Number(optionalEnv('PLAN_MAX_CLIPS', '15')) || 15));
