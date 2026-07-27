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
};

/**
 * Eén Claude-call die gegarandeerd JSON teruggeeft volgens `schema`.
 *
 * Vorm afgedwongen met forced tool use in plaats van output_config.format: dat
 * werkt op elk model, dus wisselen van model breekt de pipeline niet. Bij
 * invalid JSON volgt precies één repair-retry met de zod-fout erbij; daarna
 * gooien we, zodat de fout zichtbaar wordt in plaats van stilletjes doorrolt.
 *
 * We streamen altijd: deze calls hebben een hoge max_tokens en niet-streamend
 * lopen die tegen de HTTP-timeout van de SDK aan.
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
    const stream = anthropic().messages.stream({
      model: CLAUDE_MODEL,
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
