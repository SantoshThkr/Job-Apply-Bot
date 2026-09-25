import type { Env } from '../config.ts';
import type { JobAnalysisProvider } from './analyzer.ts';
import { OllamaJobAnalysisProvider } from './ollama.ts';
import { OpenAiJobAnalysisProvider } from './openai.ts';

export function createProvider(env: Env, fetchImpl: typeof fetch = fetch): JobAnalysisProvider {
  if (env.AI_PROVIDER === 'openai') {
    return new OpenAiJobAnalysisProvider({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      attempts: env.AI_MAX_ATTEMPTS,
      fetch: fetchImpl,
    });
  }
  return new OllamaJobAnalysisProvider({
    baseUrl: env.OLLAMA_BASE_URL,
    model: env.OLLAMA_MODEL,
    attempts: env.AI_MAX_ATTEMPTS,
    fetch: fetchImpl,
  });
}
