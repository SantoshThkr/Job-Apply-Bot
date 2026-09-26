import { describe, expect, it, vi } from 'vitest';
import { AiError, type JobForAnalysis } from '../src/ai/analyzer.ts';
import { OpenAiJobAnalysisProvider } from '../src/ai/openai.ts';
import { evidence, testProfile } from './fixtures.ts';

// Every request goes to a mocked fetch; these tests never reach OpenAI.

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

const completion = (content: string | null, overrides: object = {}) =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content, refusal: null }, ...overrides }] }));
const failure = (status: number, code?: string) => new Response(JSON.stringify({ error: { message: 'Request failed.', code } }), { status });

function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const response of responses) fn.mockResolvedValueOnce(response);
  return fn;
}
const provider = (fetchImpl: typeof fetch, apiKey: string | undefined) =>
  new OpenAiJobAnalysisProvider({ apiKey, model: 'test-model', attempts: 2, fetch: fetchImpl, retryDelayMs: 0 });

describe('OpenAiJobAnalysisProvider', () => {
  it('sends a strict structured-output request and returns validated evidence', async () => {
    const expected = evidence({ reason: 'Solid Python and RAG overlap.' });
    const fetchImpl = mockFetch(completion(JSON.stringify(expected)));
    await expect(provider(fetchImpl, 'test-key').analyze(job, testProfile)).resolves.toEqual(expected);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('test-model');
    expect(body.response_format.json_schema).toMatchObject({ name: 'job_match_evidence', strict: true });
  });

  it('retries rate limits and server errors, then succeeds', async () => {
    const fetchImpl = mockFetch(failure(429), failure(503), completion(JSON.stringify(evidence())));
    await expect(provider(fetchImpl, 'test-key').analyze(job, testProfile)).resolves.toEqual(evidence());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['a rejected key', failure(401)],
    ['an unknown model', failure(404, 'model_not_found')],
    ['exhausted quota', failure(429, 'insufficient_quota')],
    ['an invalid request', failure(400, 'invalid_request_error')],
  ])('stops the run on %s', async (_, response) => {
    const fetchImpl = mockFetch(response);
    const error = await provider(fetchImpl, 'test-key').analyze(job, testProfile).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ fatal: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries output that fails validation, then gives up', async () => {
    const fetchImpl = mockFetch(completion('{"score": 99}'), completion(null, { message: { content: null, refusal: 'No.' } }));
    await expect(provider(fetchImpl, 'test-key').analyze(job, testProfile)).rejects.toMatchObject({ fatal: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('is not ready without a key and makes no request', async () => {
    const fetchImpl = mockFetch();
    await expect(provider(fetchImpl, undefined).ensureReady()).rejects.toThrow(/OPENAI_API_KEY is not set/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
