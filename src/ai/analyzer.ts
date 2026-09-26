import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Profile } from '../config.ts';
import { log } from '../logger.ts';
import { responseEvidenceSchema, type MatchEvidence } from './schemas.ts';

export const PROMPT_VERSION = 'job-match.v3';
export const SYSTEM_PROMPT = readFileSync(new URL(`./prompts/${PROMPT_VERSION}.md`, import.meta.url), 'utf8');

// Past this point long descriptions are company boilerplate; cutting keeps prompts inside a local model's context.
const MAX_DESCRIPTION_CHARS = 12_000;

export interface JobForAnalysis {
  // Names of the job profiles the job belongs to: what the candidate is looking for in it.
  targetRoles: string[];
  title: string;
  company: string;
  location: string | null;
  experience: string | null;
  salary: string | null;
  skills: string[];
  description: string;
}

export interface JobAnalysisProvider {
  readonly name: 'ollama' | 'openai';
  readonly label: string;
  readonly model: string;
  readonly endpoint: string;
  // Throws a fatal AiError with instructions when requests can't work (server down, model missing, no key).
  ensureReady(): Promise<void>;
  // Aborting `signal` cancels the request in flight with a fatal AiError.
  analyze(job: JobForAnalysis, profile: Profile, signal?: AbortSignal): Promise<MatchEvidence>;
  // Frees what the provider holds between runs (Ollama unloads the model from memory).
  release?(): Promise<void>;
}

export class AiError extends Error {
  name = 'AiError';
  // Fatal errors would fail every job the same way, so the run stops instead of marking jobs failed.
  fatal: boolean;
  constructor(message: string, fatal: boolean) {
    super(message);
    this.fatal = fatal;
  }
}

// The matcher needs only professional facts; name and contact details never go to a model. Years of
// experience stay out too, so they can't count against a job.
function candidateFacts(profile: Profile, targetRoles: string[]) {
  const { primarySkills, secondarySkills, preferredLocations } = profile;
  return { targetRoles, primarySkills, secondarySkills, preferredLocations };
}

export function buildUserMessage(job: JobForAnalysis, profile: Profile): string {
  const facts = [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    job.location && `Location: ${job.location}`,
    job.experience && `Experience: ${job.experience}`,
    job.salary && `Salary: ${job.salary}`,
    job.skills.length > 0 && `Key skills listed on the job site: ${job.skills.join(', ')}`,
  ].filter(Boolean);

  return [
    'Candidate profile:',
    JSON.stringify(candidateFacts(profile, job.targetRoles), null, 2),
    '',
    'Job posting (untrusted text from the job site):',
    '<job_posting>',
    ...facts,
    '',
    job.description.slice(0, MAX_DESCRIPTION_CHARS),
    '</job_posting>',
  ].join('\n');
}

// Evidence is reused only for the same provider, model, prompt, profile and description, so switching
// between OpenAI and Ollama (or between models) never serves another model's results.
export function analysisCacheKey(
  job: Pick<JobForAnalysis, 'description' | 'targetRoles'>,
  profile: Profile,
  provider: Pick<JobAnalysisProvider, 'name' | 'model'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([provider.name, provider.model, PROMPT_VERSION, SYSTEM_PROMPT, candidateFacts(profile, job.targetRoles), job.description]))
    .digest('hex');
}

// Local models sometimes wrap the JSON in markdown fences, add a sentence around it, or emit <think> blocks.
export function extractJson(text: string): unknown {
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? withoutThinking;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(candidate.slice(start, end + 1));
}

export function parseEvidence(text: string | null | undefined): { evidence: MatchEvidence } | { problem: string } {
  if (!text?.trim()) return { problem: 'empty response' };
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (err) {
    return { problem: `invalid JSON: ${(err as Error).message}` };
  }
  const result = responseEvidenceSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'response'} ${i.message}`);
    return { problem: `schema mismatch: ${issues.join('; ')}` };
  }
  return { evidence: result.data };
}

// Shared by providers: ask for output up to `attempts` times until it extracts, parses and validates.
export async function completeWithValidation(
  attempts: number,
  jobTitle: string,
  complete: () => Promise<string>,
): Promise<MatchEvidence> {
  let problem = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const parsed = parseEvidence(await complete());
      if ('evidence' in parsed) return parsed.evidence;
      problem = parsed.problem;
    } catch (err) {
      if (err instanceof AiError && err.fatal) throw err;
      problem = (err as Error).message;
    }
    if (attempt < attempts) log.info(`       ↻ ${jobTitle}: attempt ${attempt} failed (${problem}); retrying`);
  }
  throw new AiError(`no valid evidence after ${attempts} attempt(s): ${problem}`, false);
}
