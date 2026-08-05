import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CLAUDE_MODEL, optionalEnv, requireEnv } from './env';
import { logProviderUsage } from './supabase';

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  return client;
}

// Prijzen per miljoen tokens (Opus 5: $5 in / $25 uit, ruw omgerekend naar euro).
const INPUT_EUR_PER_MTOK = 4.6;
const OUTPUT_EUR_PER_MTOK = 23;

export class SchemaValidationError extends Error {
  constructor(
    message: string,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

type StructuredOptions<T extends z.ZodTypeAny> = {
  system: string;
  user: string;
  schema: T;
  toolName: string;
  toolDescription: string;
  maxTokens?: number;
  effort?: Effort;
  operation: string;
  /**
   * Modeloverride voor licht werk (classificatie, import-parsing). Een kleiner
   * model telt minder zwaar mee in de abonnementslimiet; het creatieve werk
   * (plannen, scripts) blijft op het hoofdmodel.
   */
  model?: string;
  /**
   * Sta WebSearch/WebFetch toe in de CLI-call. Alleen voor de kennis-agent:
   * generatiecalls horen deterministisch op hun invoer te werken.
   */
  webResearch?: boolean;
};

/**
 * Eén Claude-call die gegarandeerd JSON teruggeeft volgens `schema`, met één
 * repair-retry bij invalid JSON en daarna een harde fout.
 *
 * Twee backends, gekozen via CLAUDE_BACKEND:
 * - 'claude-code': via de lokale Claude Code CLI, betaald uit je abonnement in
 *   plaats van API-credits. Vereist een ingelogde CLI (`claude login`) en werkt
 *   alleen op je eigen machine, niet op Vercel.
 * - 'api': rechtstreeks tegen de Anthropic API met ANTHROPIC_API_KEY.
 */
export async function structuredCall<T extends z.ZodTypeAny>(opts: StructuredOptions<T>): Promise<z.infer<T>> {
  const backend = optionalEnv('CLAUDE_BACKEND', 'api');
  if (backend === 'claude-code') return claudeCodeStructuredCall(opts);
  return apiStructuredCall(opts);
}

/* ------------------------------------------------------------ API-backend */

/**
 * Vorm afgedwongen met forced tool use in plaats van output_config.format: dat
 * werkt op elk model, dus wisselen van model breekt de pipeline niet.
 * We streamen altijd: deze calls hebben een hoge max_tokens en niet-streamend
 * lopen die tegen de HTTP-timeout van de SDK aan.
 */
async function apiStructuredCall<T extends z.ZodTypeAny>(opts: StructuredOptions<T>): Promise<z.infer<T>> {
  const jsonSchema = zodToJsonSchema(opts.schema, { target: 'openApi3' }) as Record<string, unknown>;
  delete jsonSchema.$schema;

  const tool: Anthropic.Tool = {
    name: opts.toolName,
    description: opts.toolDescription,
    input_schema: jsonSchema as Anthropic.Tool.InputSchema,
  };

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.user }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const stream = anthropic().messages.stream({
      model: opts.model ?? CLAUDE_MODEL,
      max_tokens: opts.maxTokens ?? 32000,
      // Geen temperature: Opus 5 accepteert sampling-parameters niet. Consistentie
      // komt uit de vastgelegde prompt-versie en vault-snapshot per plan.
      output_config: { effort: opts.effort ?? 'high' },
      system: opts.system,
      tools: [tool],
      tool_choice: { type: 'tool', name: opts.toolName },
      messages,
    });

    const response = await stream.finalMessage();

    void logProviderUsage(
      'anthropic',
      opts.operation,
      response.usage.input_tokens + response.usage.output_tokens,
      (response.usage.input_tokens / 1e6) * INPUT_EUR_PER_MTOK +
        (response.usage.output_tokens / 1e6) * OUTPUT_EUR_PER_MTOK,
    ).catch(() => undefined);

    if (response.stop_reason === 'refusal') {
      throw new SchemaValidationError(
        `Model weigerde de vraag (${opts.operation}): ${response.stop_details?.explanation ?? 'geen toelichting'}`,
        response.stop_details,
      );
    }

    const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!block) {
      const reason = response.stop_reason === 'max_tokens' ? ' (max_tokens bereikt — verhoog maxTokens)' : '';
      throw new SchemaValidationError(`Model gaf geen tool_use terug (${opts.operation})${reason}`, response.content);
    }

    const parsed = opts.schema.safeParse(block.input);
    if (parsed.success) return parsed.data;

    if (attempt === 1) {
      throw new SchemaValidationError(
        `Ongeldige output na repair-retry (${opts.operation}): ${parsed.error.message}`,
        block.input,
      );
    }

    // Repair-retry: geef het model zijn eigen output plus de validatiefout terug.
    // response.content gaat integraal mee, inclusief thinking-blokken — die mag
    // je niet strippen bij een vervolgbeurt op hetzelfde model.
    messages.push(
      { role: 'assistant', content: response.content },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: block.id,
            is_error: true,
            content: `De output voldeed niet aan het schema. Fouten:\n${parsed.error.message}\n\nRoep ${opts.toolName} opnieuw aan met gecorrigeerde waarden.`,
          },
        ],
      },
    );
  }

  throw new SchemaValidationError(`Onbereikbaar (${opts.operation})`, null);
}

/* ----------------------------------------------------- Claude Code-backend */

/**
 * De CLI kent low/medium/high/max; xhigh bestaat daar niet. We ronden naar
 * boven af: het plan en de scripts zijn het inhoudelijke hart en verdienen op
 * het abonnement de maximale denkdiepte.
 */
function cliEffort(effort: Effort | undefined): string {
  const value = effort ?? 'high';
  return value === 'xhigh' ? 'max' : value;
}

async function claudeCodeStructuredCall<T extends z.ZodTypeAny>(opts: StructuredOptions<T>): Promise<z.infer<T>> {
  const jsonSchema = zodToJsonSchema(opts.schema, { target: 'openApi3' }) as Record<string, unknown>;
  delete jsonSchema.$schema;

  const basePrompt = `${opts.user}

=== OUTPUTFORMAAT ===
${opts.toolDescription}
Antwoord met uitsluitend geldige JSON die exact voldoet aan dit JSON-schema. Geen toelichting, geen markdown-codeblokken, alleen het JSON-object zelf.
${JSON.stringify(jsonSchema)}`;

  let prompt = basePrompt;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { result, costUsd, tokens } = await runClaudeCli(
      opts.system,
      prompt,
      cliEffort(opts.effort),
      opts.model ?? CLAUDE_MODEL,
      opts.webResearch ?? false,
    );

    void logProviderUsage('claude-code', opts.operation, tokens, costUsd * 0.92).catch(() => undefined);

    const extracted = extractJson(result);
    if (extracted === null) {
      if (attempt === 1) {
        throw new SchemaValidationError(`Geen JSON in CLI-antwoord (${opts.operation})`, result.slice(0, 2000));
      }
      prompt = `${basePrompt}

Je vorige antwoord bevatte geen parseerbare JSON. Antwoord nu met uitsluitend het JSON-object.`;
      continue;
    }

    const parsed = opts.schema.safeParse(extracted);
    if (parsed.success) return parsed.data;

    if (attempt === 1) {
      throw new SchemaValidationError(
        `Ongeldige output na repair-retry (${opts.operation}): ${parsed.error.message}`,
        extracted,
      );
    }

    prompt = `${basePrompt}

Je vorige antwoord was:
${JSON.stringify(extracted).slice(0, 20000)}

Dat voldeed niet aan het schema. Fouten:
${parsed.error.message}

Lever nu uitsluitend het gecorrigeerde JSON-object.`;
  }

  throw new SchemaValidationError(`Onbereikbaar (${opts.operation})`, null);
}

/**
 * Draait `claude -p` als los proces. De prompt gaat via stdin (transcripten
 * zijn te groot voor argumenten). We vegen de sessievariabelen van een
 * eventueel bovenliggende Claude Code-sessie uit de omgeving, anders denkt de
 * CLI dat hij genest draait en faalt de OAuth-refresh; en we halen
 * ANTHROPIC_API_KEY weg zodat dit gegarandeerd op het abonnement draait en
 * nooit stiekem op API-credits.
 */
async function runClaudeCli(
  system: string,
  prompt: string,
  effort: string,
  model: string,
  webResearch = false,
): Promise<{ result: string; costUsd: number; tokens: number }> {
  // Voorbijgaande streamfouten (stalled, overloaded, 5xx) mogen geen hele
  // plannerrun weggooien: tot twee keer opnieuw proberen met korte pauze.
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 15_000));
    try {
      return await runClaudeCliOnce(system, prompt, effort, model, webResearch);
    } catch (err) {
      lastErr = err as Error;
      const transient = /stalled|overloaded|rate.?limit|50[0-9]|timed? ?out|ECONNRESET|socket hang up/i.test(
        lastErr.message,
      );
      if (!transient) throw lastErr;
      console.warn(`[claude-cli] tijdelijke fout (poging ${attempt + 1}/3): ${lastErr.message.slice(0, 160)}`);
    }
  }
  throw lastErr!;
}

function runClaudeCliOnce(
  system: string,
  prompt: string,
  effort: string,
  model: string,
  webResearch = false,
): Promise<{ result: string; costUsd: number; tokens: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE') || key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_BASE_URL') {
      delete env[key];
    }
  }
  // Uitzondering op de schoonmaak: de langlevende abonnements-token van
  // `claude setup-token`. Op een server (GitHub Actions) is dit de enige auth.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--effort',
    effort,
    '--system-prompt',
    system,
    '--no-session-persistence',
    // Dit is pure generatie; de agent-tools van Claude Code blijven uit.
    '--disallowed-tools',
    webResearch
      ? 'Bash,Edit,Write,Read,Glob,Grep,Task,NotebookEdit,TodoWrite'
      : 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', () =>
      reject(new Error('Claude Code CLI niet gevonden. Installeer hem of zet CLAUDE_BACKEND=api.')),
    );
    child.on('close', (code) => {
      try {
        // Ook bij exitcode 1 zet de CLI zijn foutmelding als JSON op stdout;
        // die is veel leesbaarder dan een kale exitcode.
        const json = JSON.parse(stdout) as {
          result?: string;
          is_error?: boolean;
          total_cost_usd?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        const result = json.result ?? '';
        if (/Failed to authenticate|OAuth access token|not logged in/i.test(result)) {
          return reject(
            new Error(
              `Claude Code CLI is niet (meer) ingelogd. Draai eenmalig \`claude login\` in een losse terminal, of zet CLAUDE_BACKEND=api. Melding: ${result.slice(0, 200)}`,
            ),
          );
        }
        if (json.is_error) {
          // Geen auth-probleem: geef de echte melding door, zodat de
          // retry-laag tijdelijke fouten (stalled/overloaded) kan herkennen.
          return reject(new Error(`claude CLI fout: ${result.slice(0, 300)}`));
        }
        if (code !== 0) {
          return reject(new Error(`claude CLI exit ${code}: ${result.slice(0, 300) || stderr.trim().slice(-300)}`));
        }
        resolve({
          result,
          costUsd: json.total_cost_usd ?? 0,
          tokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
        });
      } catch {
        reject(new Error(`claude CLI exit ${code}: ${(stderr || stdout).trim().slice(-400)}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Pakt het eerste JSON-object uit een antwoord, ook als er tekst of fences omheen staan. */
export function extractJson(text: string): unknown | null {
  const candidates = [text.trim()];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // volgende kandidaat proberen
    }
  }
  return null;
}
