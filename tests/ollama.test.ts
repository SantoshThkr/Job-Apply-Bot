import { describe, expect, it, vi } from 'vitest';
import { AiError, type JobForAnalysis } from '../src/ai/analyzer.ts';
import { OllamaJobAnalysisProvider } from '../src/ai/ollama.ts';
import { createProvider } from '../src/ai/providers.ts';
import { loadEnv } from '../src/config.ts';
import { evidence, testProfile } from './fixtures.ts';

// Ollama is mocked; these tests need neither a running server nor the internet.

const job: JobForAnalysis = {
  targetRoles: ['AI Engineer'],
  title: 'AI Engineer',
  company: 'Acme',
  location: 'Bengaluru',
  experience: '5-10 Yrs',
  salary: null,
  skills: ['Python'],
  description: 'Build retrieval-augmented generation services in Python.',
};
const valid = JSON.stringify(evidence({ reason: 'Python and RAG overlap.' }));

const chat = (content: string, doneReason = 'stop') =>
  new Response(JSON.stringify({ model: 'qwen3:8b', message: { role: 'assistant', content }, done: true, done_reason: doneReason }));
const tags = (...names: string[]) => new Response(JSON.stringify({ models: names.map((name) => ({ name, model: name })) }));
const error = (status: number, message: string) => new Response(JSON.stringify({ error: message }), { status });

function mockFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) fn.mockRejectedValueOnce(response);
    else fn.mockResolvedValueOnce(response);
  }
  return fn;
}
const provider = (fetchImpl: typeof fetch, model = 'qwen3:8b') =>
  new OllamaJobAnalysisProvider({ baseUrl: 'http://localhost:11434/', model, attempts: 3, fetch: fetchImpl });
const connectionRefused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

describe('ensureReady', () => {
  it('passes when the server is up and the model is installed', async () => {
    const fetchImpl = mockFetch(tags('llama3.2:latest', 'qwen3:8b'));
    await expect(provider(fetchImpl).ensureReady()).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://localhost:11434/api/tags');
  });

  it('treats a model without a tag as :latest', async () => {
    await expect(provider(mockFetch(tags('qwen3:latest')), 'qwen3').ensureReady()).resolves.toBeUndefined();
  });

  it('explains how to start Ollama when it is not running', async () => {
    const error = await provider(mockFetch(connectionRefused())).ensureReady().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ fatal: true, message: 'Ollama is not running at http://localhost:11434.\nStart Ollama and run the command again.' });
  });

  it('explains how to install a missing model without downloading it', async () => {
    const fetchImpl = mockFetch(tags('llama3.2:latest'));
    const error = await provider(fetchImpl).ensureReady().catch((e: unknown) => e);
    expect(error).toMatchObject({ fatal: true });
    expect((error as Error).message).toContain('the configured model "qwen3:8b" is not installed');
    expect((error as Error).message).toContain('ollama pull qwen3:8b');
    expect((error as Error).message).toContain('(llama3.2:latest)');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('analyze', () => {
  it('asks the local server for schema-constrained JSON and returns validated evidence', async () => {
    const fetchImpl = mockFetch(chat(valid));
    await expect(provider(fetchImpl).analyze(job, testProfile)).resolves.toEqual(JSON.parse(valid));

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ model: 'qwen3:8b', stream: false, think: false, options: { temperature: 0, num_ctx: 8192 } });
    expect(body.format).toMatchObject({ type: 'object', additionalProperties: false });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[1].content).not.toContain(testProfile.name);
  });

  it('accepts markdown-wrapped JSON', async () => {
    await expect(provider(mockFetch(chat(`\`\`\`json\n${valid}\n\`\`\``))).analyze(job, testProfile)).resolves.toEqual(JSON.parse(valid));
  });

  it('retries malformed JSON, a cut-off answer and a server error, then succeeds', async () => {
    const fetchImpl = mockFetch(chat('{"roleRelevance": "STR'), chat(valid.slice(0, 40), 'length'), chat(valid));
    await expect(provider(fetchImpl).analyze(job, testProfile)).resolves.toEqual(JSON.parse(valid));
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const afterServerError = mockFetch(error(500, 'llama runner process has terminated'), chat(valid));
    await expect(provider(afterServerError).analyze(job, testProfile)).resolves.toBeDefined();
  });

  it('fails the job after the retry limit when required evidence stays missing', async () => {
    const missing = JSON.stringify({ roleRelevance: 'STRONG', aiFocus: 'CORE', reason: 'Looks good.' });
    const fetchImpl = mockFetch(chat(missing), chat(missing), chat(missing), chat(valid));
    const failure = await provider(fetchImpl).analyze(job, testProfile).catch((e: unknown) => e);
    expect(failure).toMatchObject({ fatal: false, message: expect.stringMatching(/^no valid evidence after 3 attempt\(s\): schema mismatch: requiredSkills/) });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops the run when the model disappears or the server goes away', async () => {
    await expect(provider(mockFetch(error(404, "model 'qwen3:8b' not found"))).analyze(job, testProfile)).rejects.toMatchObject({
      fatal: true,
      message: expect.stringContaining('ollama pull qwen3:8b'),
    });
    await expect(provider(mockFetch(connectionRefused())).analyze(job, testProfile)).rejects.toMatchObject({ fatal: true });
  });

  it('drops the think option for models that reject it', async () => {
    const fetchImpl = mockFetch(error(400, '"llama3.2:latest" does not support thinking'), chat(valid));
    await expect(provider(fetchImpl, 'llama3.2:latest').analyze(job, testProfile)).resolves.toBeDefined();
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string)).not.toHaveProperty('think');
  });
});

describe('provider selection', () => {
  it('uses local Ollama by default and never contacts OpenAI', async () => {
    const fetchImpl = mockFetch(tags('qwen3:4b'), chat(valid));
    const local = createProvider(loadEnv({}), fetchImpl);
    expect(local).toMatchObject({ name: 'ollama', model: 'qwen3:4b', endpoint: 'http://localhost:11434' });

    await local.ensureReady();
    await local.analyze(job, testProfile);
    const hosts = fetchImpl.mock.calls.map(([url]) => new URL(String(url)).host);
    expect(hosts).toEqual(['localhost:11434', 'localhost:11434']);
  });

  it('honours OLLAMA_BASE_URL and OLLAMA_MODEL, and selects OpenAI only when asked', () => {
    const custom = createProvider(loadEnv({ OLLAMA_BASE_URL: 'http://127.0.0.1:9999', OLLAMA_MODEL: 'llama3.2:3b' }));
    expect(custom).toMatchObject({ name: 'ollama', model: 'llama3.2:3b', endpoint: 'http://127.0.0.1:9999' });
    expect(createProvider(loadEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' }))).toMatchObject({ name: 'openai' });
  });
});
