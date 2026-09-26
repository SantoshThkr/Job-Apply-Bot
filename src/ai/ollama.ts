import { z } from 'zod';
import type { Profile } from '../config.ts';
import { AiError, SYSTEM_PROMPT, buildUserMessage, completeWithValidation, type JobAnalysisProvider, type JobForAnalysis } from './analyzer.ts';
import { matchEvidenceJsonSchema, type MatchEvidence } from './schemas.ts';

// Free local provider: requests go only to the Ollama server at OLLAMA_BASE_URL (localhost by default).

// A local model on a laptop can take a while on a long posting; this only guards against a hung server.
const REQUEST_TIMEOUT_MS = 300_000;
// Room for the prompt (instructions + profile + up to ~3k tokens of description) plus the JSON answer.
// Ollama's default context is smaller and would silently cut the description.
const CONTEXT_TOKENS = 8_192;

const tagsSchema = z.object({ models: z.array(z.object({ name: z.string() })) });
const chatSchema = z.object({ message: z.object({ content: z.string() }), done_reason: z.string().optional() });

// "qwen3" and "qwen3:latest" are the same model to Ollama.
const withTag = (model: string) => (model.includes(':') ? model : `${model}:latest`);

export class OllamaJobAnalysisProvider implements JobAnalysisProvider {
  readonly name = 'ollama';
  readonly label = 'Ollama';
  readonly model: string;
  readonly endpoint: string;
  #attempts: number;
  #fetch: typeof fetch;
  #sendThink = true;

  constructor(options: { baseUrl: string; model: string; attempts?: number; fetch?: typeof fetch }) {
    this.endpoint = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.#attempts = options.attempts ?? 3;
    this.#fetch = options.fetch ?? fetch;
  }

  async ensureReady(): Promise<void> {
    let body: unknown;
    try {
      const response = await this.#fetch(`${this.endpoint}/api/tags`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch {
      throw new AiError(`Ollama is not running at ${this.endpoint}.\nStart Ollama and run the command again.`, true);
    }
    const parsed = tagsSchema.safeParse(body);
    const installed = parsed.success ? parsed.data.models.map((m) => m.name) : [];
    if (!installed.some((name) => withTag(name) === withTag(this.model))) {
      throw new AiError(
        `Ollama is running, but the configured model "${this.model}" is not installed.\n` +
          `Install it with:\n\n  ollama pull ${this.model}\n\n` +
          `or set OLLAMA_MODEL in .env to an installed model (${installed.join(', ') || 'none installed yet'}).`,
        true,
      );
    }
  }

  analyze(job: JobForAnalysis, profile: Profile, signal?: AbortSignal): Promise<MatchEvidence> {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(job, profile) },
    ];
    return completeWithValidation(this.#attempts, job.title, () => this.#chat(messages, signal));
  }

  // Ollama keeps a model in memory for minutes after the last request; this unloads it at once.
  async release(): Promise<void> {
    await this.#fetch(`${this.endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, keep_alive: 0 }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }

  async #chat(messages: object[], signal?: AbortSignal): Promise<string> {
    const body = {
      model: this.model,
      messages,
      stream: false,
      // Ollama constrains generation to this JSON schema; the response is still validated afterwards.
      format: matchEvidenceJsonSchema,
      // Thinking models (qwen3) would otherwise reason at length before answering; the evidence doesn't need it.
      ...(this.#sendThink && { think: false }),
      options: { temperature: 0, num_ctx: CONTEXT_TOKENS },
    };

    let response: Response;
    try {
      response = await this.#fetch(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (signal?.aborted) throw new AiError('Stopped', true);
      if ((err as Error).name === 'TimeoutError') throw new AiError(`no answer within ${REQUEST_TIMEOUT_MS / 1_000}s`, false);
      throw new AiError(`Ollama stopped responding at ${this.endpoint}. Check that it is still running.`, true);
    }

    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    if (response.status === 404) {
      throw new AiError(`Ollama model "${this.model}" is not installed. Install it with: ollama pull ${this.model}`, true);
    }
    // Older Ollama versions and non-thinking models may reject the think option; drop it and ask again.
    if (response.status === 400 && this.#sendThink && /think/i.test(payload?.error ?? '')) {
      this.#sendThink = false;
      return this.#chat(messages, signal);
    }
    if (!response.ok) throw new AiError(`Ollama error ${response.status}: ${payload?.error ?? response.statusText}`, false);

    const chat = chatSchema.safeParse(payload);
    if (!chat.success) throw new AiError('unexpected response shape from Ollama', false);
    if (chat.data.done_reason === 'length') throw new AiError('the response was cut off', false);
    return chat.data.message.content;
  }
}
