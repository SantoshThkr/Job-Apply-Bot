import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Profile } from '../config.ts';
import { AiError, SYSTEM_PROMPT, buildUserMessage, completeWithValidation, type JobAnalysisProvider, type JobForAnalysis } from './analyzer.ts';
import { matchEvidenceJsonSchema, type MatchEvidence } from './schemas.ts';

// Optional paid provider (AI_PROVIDER=openai). Nothing here runs in the default Ollama mode.

const MAX_HTTP_ATTEMPTS = 3;

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }),
      }),
    )
    .min(1),
});

export class OpenAiJobAnalysisProvider implements JobAnalysisProvider {
  readonly name = 'openai';
  readonly label = 'OpenAI';
  readonly endpoint = 'https://api.openai.com/v1/chat/completions';
  readonly model: string;
  #apiKey: string | undefined;
  #attempts: number;
  #fetch: typeof fetch;
  #retryDelayMs: number;

  constructor(options: { apiKey: string | undefined; model: string; attempts?: number; fetch?: typeof fetch; retryDelayMs?: number }) {
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.#attempts = options.attempts ?? 2;
    this.#fetch = options.fetch ?? fetch;
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  async ensureReady(): Promise<void> {
    if (!this.#apiKey) throw new AiError('OPENAI_API_KEY is not set. Add it to .env, or use AI_PROVIDER=ollama.', true);
  }

  analyze(job: JobForAnalysis, profile: Profile, signal?: AbortSignal): Promise<MatchEvidence> {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(job, profile) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'job_match_evidence', strict: true, schema: matchEvidenceJsonSchema },
      },
    };
    return completeWithValidation(this.#attempts, job.title, async () => {
      const completion = completionSchema.safeParse(await this.#post(body, signal));
      const choice = completion.success ? completion.data.choices[0] : undefined;
      if (!choice) throw new AiError('unexpected response shape', false);
      if (choice.message.refusal) throw new AiError(`the model refused: ${choice.message.refusal}`, false);
      if (choice.finish_reason === 'length') throw new AiError('the response was cut off', false);
      return choice.message.content ?? '';
    });
  }

  async #post(body: object, signal?: AbortSignal): Promise<unknown> {
    if (!this.#apiKey) throw new AiError('OPENAI_API_KEY is not set.', true);
    for (let attempt = 1; ; attempt++) {
      const backoffMs = this.#retryDelayMs * 2 ** (attempt - 1);
      let response: Response;
      try {
        response = await this.#fetch(this.endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
        });
      } catch (err) {
        if (signal?.aborted) throw new AiError('Stopped', true);
        if (attempt >= MAX_HTTP_ATTEMPTS) throw new AiError(`OpenAI request failed: ${(err as Error).message}`, false);
        await sleep(backoffMs);
        continue;
      }
      if (response.ok) return response.json();

      const error = ((await response.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null)
        ?.error;
      const detail = error?.message ?? response.statusText;
      if (response.status === 401 || response.status === 403) {
        throw new AiError(`OpenAI rejected the API key (${response.status}). Check OPENAI_API_KEY in .env.`, true);
      }
      if (response.status === 404 || error?.code === 'model_not_found') {
        throw new AiError(`OpenAI model "${this.model}" is not available: ${detail} Set OPENAI_MODEL in .env.`, true);
      }
      if (error?.code === 'insufficient_quota') throw new AiError(`OpenAI quota exhausted: ${detail}`, true);

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_HTTP_ATTEMPTS) {
        // A 400 usually means the request itself is wrong (and would be for every job), except an oversized posting.
        const fatal = response.status === 400 && error?.code !== 'context_length_exceeded';
        throw new AiError(`OpenAI error ${response.status}: ${detail}`, fatal);
      }
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      await sleep(retryAfterSeconds > 0 ? Math.min(retryAfterSeconds * 1_000, 60_000) : backoffMs);
    }
  }
}
