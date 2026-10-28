import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CLAUDE_LICHT_MODEL, CLAUDE_MODEL, optionalEnv, requireEnv } from './env';
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
  /**
   * Paden naar beeldframes die het model mag bekijken. Alleen dan krijgt de
   * CLI leestoegang, en alleen tot deze bestanden: zonder beeld verzint een
   * model alles wat visueel is.
   */
  beeldPaden?: string[];
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

  const beeldBlok =
    opts.beeldPaden && opts.beeldPaden.length > 0
      ? `\n\n=== BEELD ===\nBekijk deze frames met de Read-tool vóór je antwoordt; ze staan op volgorde van tijd:\n${opts.beeldPaden
          .map((p) => `- ${p}`)
          .join('\n')}\n`
      : '';

  const basePrompt = `${opts.user}${beeldBlok}

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
      (opts.beeldPaden?.length ?? 0) > 0,
      opts.maxTokens,
    );

    void logProviderUsage('claude-code', opts.operation, tokens, costUsd * 0.92).catch(() => undefined);

    let extracted = extractJson(result);
    if (extracted === null) {
      // Wat stond er dan wél? Zonder dit was "Geen JSON" een raadsel: het
      // begin laat zien of het tekst rond het JSON was, een weigering of een
      // foutmelding; het eind of het antwoord is afgebroken.
      console.warn(
        `[claude-cli] geen parseerbare JSON (${opts.operation}, poging ${attempt + 1}, ${result.length} tekens). ` +
          `Begin: ${JSON.stringify(result.slice(0, 300))} … eind: ${JSON.stringify(result.slice(-120))}`,
      );
      // Eerst herstellen: het antwoord is er al (minuten denkwerk), vaak
      // klopt alleen de vorm niet — tekst eromheen, een niet-ge-escapet
      // aanhalingsteken in een citaat. Een kleine call die alleen de vorm
      // repareert is veel goedkoper dan alles opnieuw.
      extracted = await herstelJson(result, jsonSchema, opts).catch((e: Error) => {
        console.warn(`[claude-cli] JSON-herstel mislukt (${opts.operation}): ${e.message.slice(0, 160)}`);
        return null;
      });
      if (extracted === null) {
        if (attempt === 1) {
          throw new SchemaValidationError(
            `Geen JSON in CLI-antwoord (${opts.operation}) — begin antwoord: ${JSON.stringify(result.slice(0, 300))}`,
            result.slice(0, 2000),
          );
        }
        prompt = `${basePrompt}

Je vorige antwoord bevatte geen parseerbare JSON. Antwoord nu met uitsluitend het JSON-object.`;
        continue;
      }
      console.warn(`[claude-cli] JSON hersteld (${opts.operation})`);
    }

    const parsed = opts.schema.safeParse(extracted);
    if (parsed.success) return parsed.data;
    console.warn(`[claude-cli] schemafout (${opts.operation}, poging ${attempt + 1}): ${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300)}`);

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
 * Herstelpoging voor een antwoord zonder parseerbare JSON: het ruwe antwoord
 * terug met de vraag alleen het JSON-object te geven. Geen transcript, lage
 * effort — dit is vormwerk. Een afgebroken antwoord (te lang) mag hij netjes
 * afsluiten; het schema controleert daarna of er genoeg in staat.
 */
async function herstelJson<T extends z.ZodTypeAny>(
  ruw: string,
  jsonSchema: Record<string, unknown>,
  opts: StructuredOptions<T>,
): Promise<unknown | null> {
  if (!ruw.trim()) return null;
  const { result, costUsd, tokens } = await runClaudeCli(
    'Je repareert JSON. Je verandert niets aan de inhoud; je maakt alleen geldige JSON van wat er staat.',
    `Het antwoord hieronder had één JSON-object volgens het schema moeten zijn, maar is geen geldige JSON ` +
      `(tekst eromheen, markdown, niet-ge-escapete aanhalingstekens of regeleinden in strings, of afgebroken). ` +
      `Geef alleen het JSON-object: geldig, volgens het schema, met dezelfde inhoud. Is het afgebroken, sluit het dan netjes af ` +
      `zonder inhoud te verzinnen.\n\n=== SCHEMA ===\n${JSON.stringify(jsonSchema)}\n\n=== ANTWOORD ===\n${ruw}`,
    'low',
    // Vormwerk: het lichte model is hier even goed en veel sneller.
    CLAUDE_LICHT_MODEL,
  );
  void logProviderUsage('claude-code', `${opts.operation}:json_herstel`, tokens, costUsd * 0.92).catch(() => undefined);
  return extractJson(result);
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
  magLezen = false,
  maxTokens?: number,
): Promise<{ result: string; costUsd: number; tokens: number }> {
  // Voorbijgaande streamfouten (stalled, overloaded, 5xx) mogen geen hele
  // plannerrun weggooien: tot twee keer opnieuw proberen met korte pauze.
  let lastErr: Error | null = null;
  let plafond = maxTokens;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 15_000));
    try {
      return await runClaudeCliOnce(system, prompt, effort, model, webResearch, magLezen, plafond);
    } catch (err) {
      lastErr = err as Error;
      // Te lang antwoord (denkwerk telt mee in het plafond): één keer met
      // een ruimer plafond, tot 64k — dat is geen netwerkfout, maar wel te
      // verhelpen zonder iets aan de vraag te veranderen.
      const teLang = lastErr.message.match(/exceeded the (\d+) output token maximum/i);
      if (teLang && Number(teLang[1]) < 64_000) {
        plafond = Math.min(64_000, Number(teLang[1]) * 2);
        console.warn(`[claude-cli] antwoord te lang (${teLang[1]} tokens) — opnieuw met plafond ${plafond}`);
        continue;
      }
      const transient =
        /stalled|overloaded|rate.?limit|50[0-9]|timed? ?out|ECONNRESET|socket hang up/i.test(lastErr.message) ||
        // Grote structured outputs breken soms halverwege af; dat is netwerk,
        // geen inhoudelijke fout, dus opnieuw proberen loont.
        /Connection closed mid-response|incomplete/i.test(lastErr.message);
      if (!transient) throw lastErr;
      console.warn(`[claude-cli] tijdelijke fout (poging ${attempt + 1}/3): ${lastErr.message.slice(0, 160)}`);
    }
  }
  throw lastErr!;
}

/**
 * Grens waarboven de systeemprompt niet meer als argument meegaat. Linux
 * staat per argument hoogstens 128 KB toe (MAX_ARG_STRLEN), ongeacht
 * ARG_MAX: een lange video gaf daarom "spawn E2BIG" en de edit-agent viel
 * terug op standaardregels. Ruim eronder blijven.
 */
export const SYSTEEM_ARG_MAX = 64 * 1024;

let kentSysteemBestand: boolean | null = null;
/** Heeft deze CLI `--system-prompt-file`? Eén keer per proces nagevraagd. */
function cliKentSysteemBestand(bin: string): boolean {
  if (kentSysteemBestand === null) {
    try {
      const r = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 20_000 });
      kentSysteemBestand = /--system-prompt-file|--system-prompt\[-file\]/.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    } catch {
      kentSysteemBestand = false;
    }
  }
  return kentSysteemBestand;
}

/**
 * Hoe de systeemprompt de CLI bereikt: klein als argument (ongewijzigd), groot
 * via een tijdelijk bestand (`--system-prompt-file`), en als de CLI die optie
 * niet kent bovenaan de stdin-prompt met een duidelijke scheiding. Nooit meer
 * een argument boven SYSTEEM_ARG_MAX.
 */
export function systeemPromptVoorCli(
  system: string,
  prompt: string,
  opties: { kentBestand: boolean; map?: string },
): { args: string[]; prompt: string; opruimen: () => void } {
  if (Buffer.byteLength(system, 'utf8') <= SYSTEEM_ARG_MAX) {
    return { args: ['--system-prompt', system], prompt, opruimen: () => undefined };
  }
  if (opties.kentBestand) {
    const map = mkdtempSync(join(opties.map ?? tmpdir(), 'claude-systeem-'));
    const pad = join(map, 'systeem.txt');
    writeFileSync(pad, system, 'utf8');
    return { args: ['--system-prompt-file', pad], prompt, opruimen: () => rmSync(map, { recursive: true, force: true }) };
  }
  return {
    args: ['--system-prompt', 'Volg de instructies in het blok SYSTEEMINSTRUCTIES aan het begin van het bericht strikt op; ze wegen zwaarder dan de rest.'],
    prompt: `=== SYSTEEMINSTRUCTIES ===\n${system}\n=== EINDE SYSTEEMINSTRUCTIES ===\n\n${prompt}`,
    opruimen: () => undefined,
  };
}

function runClaudeCliOnce(
  system: string,
  prompt: string,
  effort: string,
  model: string,
  webResearch = false,
  magLezen = false,
  maxTokens?: number,
): Promise<{ result: string; costUsd: number; tokens: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE') || key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_BASE_URL') {
      delete env[key];
    }
  }
  // Het outputplafond van de CLI (standaard 32k, inclusief denkwerk). Alleen
  // gezet als de aanroeper meer vraagt, of na een "te lang"-melding.
  if (maxTokens && maxTokens > 32_000) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
  // Uitzondering op de schoonmaak: de langlevende abonnements-token van
  // `claude setup-token`. Op een server (GitHub Actions) is dit de enige auth.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  const bin = process.env.CLAUDE_CLI_BIN || 'claude';
  const systeem = systeemPromptVoorCli(system, prompt, { kentBestand: cliKentSysteemBestand(bin) });
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--effort',
    effort,
    ...systeem.args,
    '--no-session-persistence',
    // Dit is pure generatie; de agent-tools van Claude Code blijven uit.
    '--disallowed-tools',
    [
      'Bash', 'Edit', 'Write', 'Glob', 'Grep', 'Task', 'NotebookEdit', 'TodoWrite',
      ...(magLezen ? [] : ['Read']),
      ...(webResearch ? [] : ['WebFetch', 'WebSearch']),
    ].join(','),
    // Zonder expliciete toestemming vraagt de CLI erom en krijgt hij in een
    // automatische run geen antwoord: de kennis-agent kwam zo met lege handen
    // terug ("WebSearch en WebFetch zijn geblokkeerd").
    ...(webResearch ? ['--allowed-tools', 'WebSearch', 'WebFetch'] : []),
    ...(magLezen ? ['--allowed-tools', 'Read'] : []),
  ];

  // Een hangende CLI-aanroep (gezien: anderhalf uur op één scout-decodering,
  // 7 seconden CPU) blokkeerde de hele run zonder foutmelding. Na deze grens
  // wordt het proces afgeschoten en telt het als voorbijgaande fout, zodat
  // de retry-laag hierboven het nog eens kan proberen.
  const timeoutMs = Number(process.env.CLAUDE_CLI_TIMEOUT_MIN ?? '30') * 60_000;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env });
    let stdout = '';
    let stderr = '';
    let afgebroken = false;
    const wekker = setTimeout(() => {
      afgebroken = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(wekker);
      systeem.opruimen();
      reject(
        new Error(
          e.code === 'ENOENT'
            ? 'Claude Code CLI niet gevonden. Installeer hem of zet CLAUDE_BACKEND=api.'
            : `claude CLI kon niet starten (${e.code ?? e.message}; argumenten ${args.reduce((t, a) => t + Buffer.byteLength(a), 0)} bytes)`,
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(wekker);
      systeem.opruimen();
      if (afgebroken) {
        return reject(
          new Error(`claude CLI stalled: geen antwoord binnen ${timeoutMs / 60_000} minuten, proces afgebroken`),
        );
      }
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

    // Een proces dat meteen sneuvelt (E2BIG, ENOENT) sluit stdin; de
    // schrijffout daarvan mag de echte melding hierboven niet overschrijven.
    child.stdin.on('error', () => undefined);
    child.stdin.write(systeem.prompt);
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

  // Lokale reparatie vóór een herstel-call (die kostte in trainingsronde
  // 10 bijna een minuut): de twee vormfouten die het model in Nederlandse
  // tekst maakt — een aanhalingsteken in een citaat dat niet ge-escapet is,
  // een echte regelovergang in een string — en een afgebroken einde.
  if (first !== -1) {
    try {
      return JSON.parse(repareerJson(text.slice(first)));
    } catch {
      // dan de herstel-call
    }
  }
  // Tekst rond het JSON met zelf ook accolades ("ik lever {de analyse}…"):
  // dan klopt eerste-tot-laatste niet. Elk gebalanceerd object (strings
  // meegeteld) apart proberen, het grootste eerst.
  const objecten = gebalanceerdeObjecten(text).sort((a, b) => b.length - a.length);
  for (const candidate of objecten) {
    try {
      return JSON.parse(candidate);
    } catch {
      // volgende
    }
  }
  return null;
}

/**
 * Repareert JSON-tekst zonder iets aan de inhoud te veranderen: een " binnen
 * een string die niet door , } ] of : gevolgd wordt is een citaat en wordt
 * ge-escapet; regelovergangen in strings worden \n; een afgebroken object
 * wordt netjes gesloten. Alles na het sluitende haakje valt weg.
 */
export function repareerJson(tekst: string): string {
  let uit = '';
  let inString = false;
  const stapel: string[] = [];
  for (let i = 0; i < tekst.length; i++) {
    const c = tekst[i];
    if (inString) {
      if (c === '\\') {
        uit += c + (tekst[i + 1] ?? '');
        i++;
      } else if (c === '"') {
        const rest = tekst.slice(i + 1).match(/^\s*(.)/)?.[1];
        if (rest === undefined || /[,}\]:]/.test(rest)) {
          inString = false;
          uit += c;
        } else uit += '\\"';
      } else if (c === '\n') uit += '\\n';
      else if (c === '\r') uit += '';
      else if (c === '\t') uit += '\\t';
      else uit += c;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stapel.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      stapel.pop();
      if (stapel.length === 0) return uit + c;
    }
    uit += c;
  }
  // Afgebroken: open string sluiten, een half paar of komma weghalen, dan alles dicht.
  if (inString) uit += '"';
  uit = uit.replace(/,\s*$/, '').replace(/,\s*"[^"]*"\s*:?\s*$/, '').replace(/:\s*$/, ': null');
  return uit + stapel.reverse().join('');
}

/** Alle top-level {…}-blokken in een tekst, met accolades binnen strings genegeerd. */
function gebalanceerdeObjecten(text: string): string[] {
  const uit: string[] = [];
  for (let start = text.indexOf('{'); start !== -1 && uit.length < 20; start = text.indexOf('{', start + 1)) {
    let diepte = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') diepte++;
      else if (c === '}' && --diepte === 0) {
        uit.push(text.slice(start, i + 1));
        start = i; // verder na dit object
        break;
      }
    }
  }
  return uit;
}
