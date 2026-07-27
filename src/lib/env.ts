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
