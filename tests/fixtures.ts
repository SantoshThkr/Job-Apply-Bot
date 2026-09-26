import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobAnalysisProvider } from '../src/ai/analyzer.ts';
import type { MatchEvidence } from '../src/ai/schemas.ts';
import { jobProfilesSchema, paths, type JobProfile, type Profile } from '../src/config.ts';

// A generic full-stack/AI profile; not anyone's real data.
export const testProfile: Profile = {
  name: 'Test Candidate',
  experienceYears: 7,
  primarySkills: ['React', 'Next.js', 'TypeScript', 'JavaScript', 'Python', 'FastAPI', 'OpenAI', 'LLM', 'Generative AI', 'RAG', 'AI Agents'],
  secondarySkills: ['Angular', 'Node.js', 'PostgreSQL', 'MongoDB', 'AWS', 'Azure', 'Docker'],
  preferredLocations: ['Remote', 'Bangalore', 'Hyderabad', 'Pune', 'Delhi NCR'],
  skillAliases: {},
};

// The job profiles that ship with the repository (never a personal config/job-profiles.json).
export const testJobProfiles: JobProfile[] = jobProfilesSchema.parse(
  JSON.parse(readFileSync(join(paths.config, 'job-profiles.example.json'), 'utf8')),
);

// skills(['React', 'React'], ['LangGraph', null]): job skill paired with the profile skill the model says covers it.
export const skills = (...items: [string, string | null][]) =>
  items.map(([skill, candidateSkill]) => ({ skill, candidateSkill }));

export function evidence(overrides: Partial<MatchEvidence> = {}): MatchEvidence {
  return {
    roleRelevance: 'STRONG',
    aiFocus: 'CORE',
    requiredSkills: [],
    preferredSkills: [],
    optionalSkills: [],
    statedMinimumYears: null,
    otherRequirements: [],
    redFlags: [],
    reason: 'Test reason.',
    ...overrides,
  };
}

// A provider that answers from a function, for tests that exercise the pipeline rather than an API.
export function fakeProvider(
  answer: (description: string) => MatchEvidence | Error,
  overrides: Partial<Pick<JobAnalysisProvider, 'name' | 'model'>> = {},
) {
  const calls: string[] = [];
  const provider: JobAnalysisProvider & { calls: string[]; readyChecks: number } = {
    name: 'ollama',
    label: 'Ollama',
    model: 'test-model',
    endpoint: 'http://localhost:11434',
    calls,
    readyChecks: 0,
    ...overrides,
    async ensureReady() {
      provider.readyChecks++;
    },
    async analyze(job) {
      calls.push(job.title);
      const result = answer(job.description);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return provider;
}
