import { describe, expect, it } from 'vitest';
import {
  AiError,
  analysisCacheKey,
  buildUserMessage,
  completeWithValidation,
  extractJson,
  parseEvidence,
  type JobForAnalysis,
} from '../src/ai/analyzer.ts';
import { matchEvidenceJsonSchema } from '../src/ai/schemas.ts';
import { evidence, testProfile } from './fixtures.ts';

const job: JobForAnalysis = {
  title: 'AI Engineer',
  company: 'Acme',
  location: 'Bengaluru',
  experience: '5-10 Yrs',
  salary: null,
  skills: ['Python', 'RAG'],
  description: 'Build retrieval-augmented generation services in Python.',
};
const valid = JSON.stringify(evidence({ reason: 'Python and RAG overlap.' }));

describe('prompt input', () => {
  it('sends professional facts only and marks the posting as untrusted', () => {
    const message = buildUserMessage(job, testProfile);
    expect(message).not.toContain(testProfile.name);
    expect(message).toContain('"experienceYears": 7');
    expect(message).toContain('Job posting (untrusted text from the job site):\n<job_posting>\nTitle: AI Engineer');
    expect(message).toContain('Key skills listed on the job site: Python, RAG');
    expect(message).not.toContain('Salary:');
  });

  it('caps very long descriptions', () => {
    const message = buildUserMessage({ ...job, description: 'x'.repeat(20_000) }, testProfile);
    expect(message).toContain('x'.repeat(12_000));
    expect(message).not.toContain('x'.repeat(12_001));
  });

  it('keys the cache on provider, model, profile and description', () => {
    const ollama = { name: 'ollama', model: 'qwen3:8b' } as const;
    const key = analysisCacheKey(job, testProfile, ollama);
    expect(analysisCacheKey({ ...job }, testProfile, ollama)).toBe(key);
    expect(analysisCacheKey(job, testProfile, { name: 'openai', model: 'qwen3:8b' })).not.toBe(key);
    expect(analysisCacheKey(job, testProfile, { name: 'ollama', model: 'qwen3:4b' })).not.toBe(key);
    expect(analysisCacheKey(job, { ...testProfile, primarySkills: ['Go'] }, ollama)).not.toBe(key);
    expect(analysisCacheKey({ ...job, description: 'Different' }, testProfile, ollama)).not.toBe(key);
  });

  it('produces a JSON schema strict structured output accepts', () => {
    const problems: string[] = [];
    const check = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const schema = node as { type?: unknown; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown; items?: unknown };
      if (schema.type === 'object') {
        if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
        const keys = Object.keys(schema.properties ?? {});
        if (JSON.stringify([...(schema.required ?? [])].sort()) !== JSON.stringify([...keys].sort())) problems.push(`${path}: every property must be required`);
      }
      for (const [key, value] of Object.entries(schema.properties ?? {})) check(value, `${path}.${key}`);
      check(schema.items, `${path}[]`);
    };
    check(matchEvidenceJsonSchema, '$');
    expect(problems).toEqual([]);
    expect(matchEvidenceJsonSchema).not.toHaveProperty('$schema');
  });
});

describe('parsing model output', () => {
  it('accepts plain JSON', () => {
    expect(parseEvidence(valid)).toEqual({ evidence: JSON.parse(valid) });
  });

  it('extracts JSON from markdown fences, prose and thinking blocks', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here is the analysis:\n{"a": {"b": 2}}\nLet me know!')).toEqual({ a: { b: 2 } });
    expect(extractJson('<think>The candidate knows {React}.</think>\n{"a": 3}')).toEqual({ a: 3 });
    expect(parseEvidence(`Sure!\n\`\`\`json\n${valid}\n\`\`\``)).toHaveProperty('evidence');
  });

  it('rejects malformed JSON and missing core evidence', () => {
    expect(parseEvidence('{"roleRelevance": "STRONG", ')).toEqual({ problem: expect.stringMatching(/^invalid JSON/) });
    expect(parseEvidence('I cannot evaluate this posting.')).toEqual({ problem: 'invalid JSON: no JSON object found' });
    expect(parseEvidence('')).toEqual({ problem: 'empty response' });
    const { requiredSkills: _, ...withoutRequired } = JSON.parse(valid);
    expect(parseEvidence(JSON.stringify(withoutRequired))).toEqual({ problem: expect.stringMatching(/^schema mismatch: requiredSkills/) });
    expect(parseEvidence(JSON.stringify({ ...JSON.parse(valid), roleRelevance: 'EXCELLENT' }))).toHaveProperty('problem');
  });

  it('tolerates omitted empty lists, lowercase labels and "" for null without inventing evidence', () => {
    const loose = {
      roleRelevance: 'strong',
      aiFocus: 'Core',
      requiredSkills: [{ skill: 'Python', candidateSkill: '' }],
      preferredSkills: [],
      reason: 'Python role.',
    };
    expect(parseEvidence(JSON.stringify(loose))).toEqual({
      evidence: {
        roleRelevance: 'STRONG',
        aiFocus: 'CORE',
        requiredSkills: [{ skill: 'Python', candidateSkill: null }],
        preferredSkills: [],
        optionalSkills: [],
        statedMinimumYears: null,
        otherRequirements: [],
        redFlags: [],
        reason: 'Python role.',
      },
    });
  });
});

describe('completeWithValidation', () => {
  const answers = (...responses: (string | Error)[]) => {
    let call = 0;
    const complete = async () => {
      const next = responses[call++];
      if (next instanceof Error) throw next;
      return next ?? '';
    };
    return { complete, calls: () => call };
  };

  it('retries until the output validates', async () => {
    const { complete, calls } = answers('not json', '```json\n{"broken": \n```', valid);
    await expect(completeWithValidation(3, 'AI Engineer', complete)).resolves.toEqual(JSON.parse(valid));
    expect(calls()).toBe(3);
  });

  it('gives up after the configured number of attempts', async () => {
    const { complete, calls } = answers('{}', '{}', valid);
    const error = await completeWithValidation(2, 'AI Engineer', complete).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ fatal: false, message: expect.stringMatching(/^no valid evidence after 2 attempt\(s\): schema mismatch/) });
    expect(calls()).toBe(2);
  });

  it('treats non-fatal errors as a failed attempt but stops at once on fatal ones', async () => {
    const transient = answers(new AiError('timed out', false), valid);
    await expect(completeWithValidation(3, 'AI Engineer', transient.complete)).resolves.toBeDefined();
    const fatal = answers(new AiError('server gone', true), valid);
    await expect(completeWithValidation(3, 'AI Engineer', fatal.complete)).rejects.toMatchObject({ fatal: true });
    expect(fatal.calls()).toBe(1);
  });
});
