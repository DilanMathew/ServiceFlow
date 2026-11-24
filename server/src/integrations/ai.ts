import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * AI provider abstraction. "rules" is a deterministic, offline engine (always available, used in
 * tests and when no API key is configured); "anthropic" calls Claude with structured outputs.
 * Callers always pass a rules fallback, so AI outages never break business workflows.
 */
export interface AiResult<T> { data: T; provider: string; model: string | null; inputTokens: number; outputTokens: number; fallback: boolean }

let client: Anthropic | null = null;
function anthropic() {
  if (!client) client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 2 });
  return client;
}

export const aiProviderName = () => (config.AI_PROVIDER === 'anthropic' && config.ANTHROPIC_API_KEY ? 'anthropic' : 'rules');

export async function aiJson<T>(opts: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  fallback: () => T;
  maxTokens?: number;
}): Promise<AiResult<T>> {
  if (aiProviderName() !== 'anthropic') {
    return { data: opts.fallback(), provider: 'rules', model: null, inputTokens: 0, outputTokens: 0, fallback: false };
  }
  try {
    const res = await anthropic().messages.create({
      model: config.AI_MODEL,
      max_tokens: opts.maxTokens ?? 4000,
      system: opts.system,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: opts.schema } },
      messages: [{ role: 'user', content: opts.prompt }],
    });
    if (res.stop_reason === 'refusal') throw new Error('Model declined the request');
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
    if (!text) throw new Error('Empty AI response');
    return { data: JSON.parse(text) as T, provider: 'anthropic', model: res.model, inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens, fallback: false };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) logger.warn('AI provider rate limited; using rules fallback');
    else if (err instanceof Anthropic.APIError) logger.warn({ status: err.status }, 'AI provider error; using rules fallback');
    else logger.warn({ err: (err as Error).message }, 'AI call failed; using rules fallback');
    return { data: opts.fallback(), provider: 'rules', model: null, inputTokens: 0, outputTokens: 0, fallback: true };
  }
}
