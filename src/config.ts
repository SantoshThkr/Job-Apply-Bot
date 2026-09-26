import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const paths = {
  config: join(ROOT, 'config'),
  browserProfile: join(ROOT, 'data', 'browser-profile'),
  database: join(ROOT, 'data', 'jobs.db'),
  debug: join(ROOT, 'data', 'debug'),
  logs: join(ROOT, 'logs'),
};

export class ConfigError extends Error {
  name = 'ConfigError';
}

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const envSchema = z
  .object({
    // Local and free by default; OpenAI is opt-in.
    AI_PROVIDER: z.enum(['ollama', 'openai']).default('ollama'),
    OLLAMA_BASE_URL: z.url().default('http://localhost:11434'),
    OLLAMA_MODEL: z.string().default('qwen3:4b'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-5-mini'),
    // One request at a time keeps a local model from saturating the machine.
    AI_CONCURRENCY: int(1, 8).default(1),
    // Attempts per job when the model returns output that fails validation.
    AI_MAX_ATTEMPTS: int(1, 5).default(3),
    HEADLESS: z.stringbool().default(false),
    BROWSER_CHANNEL: z.enum(['chrome', 'chromium']).default('chrome'),
    MIN_MATCH_SCORE: int(0, 100).default(75),
    // Fill known fields and answer recruiter questions from your config.
    AUTO_FILL: z.stringbool().default(true),
    // Off: the bot checks each job and stops before Apply. On Naukri, clicking Apply (or answering the
    // last recruiter question) sends the application, so only an explicit opt-in applies.
    AUTO_APPLY: z.stringbool().default(false),
    // Optional cap on new jobs stored per search run; unset means no limit.
    MAX_JOBS_PER_RUN: int(1, 100_000).optional(),
    // Result pages read per keyword and location. Naukri can list hundreds of pages; each is a page load.
    SEARCH_MAX_PAGES: int(1, 100).default(10),
    APPLY_DELAY_MS: int(0, 600_000).default(10_000),
    DELAY_MIN_MS: int(0, 60_000).default(1500),
    DELAY_MAX_MS: int(0, 60_000).default(4000),
    // Screenshots of each application step in data/debug/<run id>/. They can show personal details.
    DEBUG_SCREENSHOTS: z.stringbool().default(false),
    // The dashboard's local API. It only ever listens on 127.0.0.1.
    API_PORT: int(1024, 65_535).default(4100),
  })
  .refine((env) => env.DELAY_MIN_MS <= env.DELAY_MAX_MS, {
    message: 'DELAY_MIN_MS must not exceed DELAY_MAX_MS',
    path: ['DELAY_MAX_MS'],
  })
  .refine((env) => env.AI_PROVIDER !== 'openai' || env.OPENAI_API_KEY, {
    message: 'OPENAI_API_KEY is required when AI_PROVIDER=openai (or set AI_PROVIDER=ollama for free local analysis)',
    path: ['OPENAI_API_KEY'],
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // `OPENAI_MODEL=` in .env means "not set"; without this, blank numbers would coerce to 0.
  const values = Object.fromEntries(Object.entries(source).filter(([, value]) => value?.trim()));
  const result = envSchema.safeParse(values);
  if (!result.success) throw new ConfigError(`Invalid .env:\n${z.prettifyError(result.error)}`);
  return result.data;
}

const text = z.string().trim().min(1);
const textList = z.array(text);

// Strict objects so a misspelled key fails loudly instead of silently falling back to a default.
export const profileSchema = z
  .strictObject({
    name: text,
    // Used to fill application forms. Experience never filters or ranks jobs.
    experienceYears: z.number().min(0).max(60),
    primarySkills: textList.min(1),
    secondarySkills: textList.default([]),
    preferredLocations: textList.min(1),
    // Extra names that count as one of your skills, e.g. { "Node.js": ["Express"] }. Built-in aliases
    // (LLM = Large Language Models, ...) live in src/jobs/skills.ts.
    skillAliases: z.record(text, textList).default({}),
    // No longer used: target roles now come from job profiles, and experience filters nothing.
    // Accepted so older profile.json files still load.
    targetRoles: textList.optional(),
    minimumExperience: z.number().optional(),
    maximumExperience: z.number().optional(),
  })
  .refine(
    (profile) => {
      const own = new Set([...profile.primarySkills, ...profile.secondarySkills].map((s) => s.toLowerCase()));
      return Object.keys(profile.skillAliases).every((skill) => own.has(skill.toLowerCase()));
    },
    { message: 'Every skillAliases key must be one of your primarySkills or secondarySkills', path: ['skillAliases'] },
  );

// Details application forms ask for. Only config/answers.json and this file ever fill a form.
export const resumeSchema = z.strictObject({
  resumePath: text,
  resumeName: text.optional(),
  email: text.optional(),
  phone: text.optional(),
  currentTitle: text,
  currentLocation: z.string().trim().default(''),
  noticePeriodDays: z.number().int().min(0).max(365),
  expectedSalary: z.string().trim().default(''),
  education: textList.default([]),
  preferredWorkMode: z.array(z.enum(['Remote', 'Hybrid', 'Office'])).default([]),
});

// Kinds of role to search for and apply to. A job belongs to every profile whose keywords or skills
// its title names (see src/jobs/filtering.ts).
export const jobProfilesSchema = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9-]+$/, 'use lowercase letters, digits and dashes'),
      name: text,
      // Naukri search terms; each is searched in every preferred location.
      keywords: textList.min(1),
      skills: textList.default([]),
      // Title words that rule a job out of this profile, e.g. "Java" for a broad web profile.
      exclude: textList.default([]),
      // How central AI work is to the role also counts towards the match score.
      ai: z.boolean().default(false),
    }),
  )
  .min(1)
  .refine((profiles) => new Set(profiles.map((p) => p.id)).size === profiles.length, { message: 'Profile ids must be unique' });

export const answersSchema = z.array(
  z.strictObject({
    // Every phrase must appear in the question (case-insensitive) for the answer to be used.
    match: textList.min(1),
    answer: text,
  }),
);

export type Profile = z.infer<typeof profileSchema>;
export type Resume = z.infer<typeof resumeSchema>;
export type JobProfile = z.infer<typeof jobProfilesSchema>[number];
export type Answer = z.infer<typeof answersSchema>[number];

// Paths of values still holding YOUR_* template text, so they never reach an application form.
function findPlaceholders(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return /\bYOUR_[A-Z_]+/.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => findPlaceholders(item, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findPlaceholders(item, path ? `${path}.${key}` : key));
  }
  return [];
}

function readConfig<T extends z.ZodType>(dir: string, file: string, schema: T): z.infer<T> {
  const example = file.replace(/\.json$/, '.example.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`config/${file} not found. Copy config/${example} to config/${file} and fill in your details.`);
    }
    throw new ConfigError(`Cannot read config/${file}: ${(err as Error).message}`);
  }

  const placeholders = findPlaceholders(raw);
  if (placeholders.length) {
    throw new ConfigError(`config/${file} still has template values at: ${placeholders.join(', ')}. Replace them with your own.`);
  }

  const result = schema.safeParse(raw);
  if (!result.success) throw new ConfigError(`Invalid config/${file}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export function loadProfile(dir = paths.config): Profile {
  return readConfig(dir, 'profile.json', profileSchema);
}

export function loadResume(dir = paths.config): Resume {
  const resume = readConfig(dir, 'resume.json', resumeSchema);
  return { ...resume, resumePath: resolve(ROOT, resume.resumePath) };
}

// config/job-profiles.json when you have one, otherwise the defaults in job-profiles.example.json.
export function loadJobProfiles(dir = paths.config): JobProfile[] {
  const file = existsSync(join(dir, 'job-profiles.json')) ? 'job-profiles.json' : 'job-profiles.example.json';
  return readConfig(dir, file, jobProfilesSchema);
}

export function loadAnswers(dir = paths.config): Answer[] {
  return readConfig(dir, 'answers.json', answersSchema);
}
