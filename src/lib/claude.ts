import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CLAUDE_MODEL, requireEnv } from './env';
import { logProviderUsage } from './supabase';

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  return client;
}

// Prijzen per miljoen tokens (Sonnet-tier). Alleen voor de kostenteller.
const INPUT_EUR_PER_MTOK = 2.8;
const OUTPUT_EUR_PER_MTOK = 14;

export class SchemaValidationError extends Error {
  constructor(
    message: string,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

type StructuredOptions<T extends z.ZodTypeAny> = {
  system: string;
  user: string;
  schema: T;
  toolName: string;
  toolDescription: string;
  maxTokens?: number;
  temperature?: number;
  operation: string;
};

/**
 * Eén Claude-call die gegarandeerd JSON teruggeeft volgens `schema`.
 *
 * We dwingen de vorm af met forced tool use in plaats van output_config.format:
 * structured outputs zijn niet op elk model beschikbaar, forced tool use wel.
 * Bij invalid JSON volgt precies één repair-retry met de zod-fout erbij; daarna
 * gooien we, zodat de fout zichtbaar wordt in plaats van stilletjes doorrolt.
 */
export async function structuredCall<T extends z.ZodTypeAny>(opts: StructuredOptions<T>): Promise<z.infer<T>> {
  const jsonSchema = zodToJsonSchema(opts.schema, { target: 'openApi3' }) as Record<string, unknown>;
  delete jsonSchema.$schema;

  const tool: Anthropic.Tool = {
    name: opts.toolName,
    description: opts.toolDescription,
    input_schema: jsonSchema as Anthropic.Tool.InputSchema,
  };

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.user }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await anthropic().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: opts.maxTokens ?? 16000,
      temperature: opts.temperature ?? 0.3,
      system: opts.system,
      tools: [tool],
      tool_choice: { type: 'tool', name: opts.toolName },
      messages,
    });

    void logProviderUsage(
      'anthropic',
      opts.operation,
      response.usage.input_tokens + response.usage.output_tokens,
      (response.usage.input_tokens / 1e6) * INPUT_EUR_PER_MTOK +
        (response.usage.output_tokens / 1e6) * OUTPUT_EUR_PER_MTOK,
    ).catch(() => undefined);

    const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!block) {
      throw new SchemaValidationError(`Model gaf geen tool_use terug (${opts.operation})`, response.content);
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
