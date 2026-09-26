import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { SavedAnswer, UserProfile } from './domain.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const paths = {
  config: join(ROOT, 'config'),
  // Everything personal: profile, answers, resume, browser session, database. Git-ignored.
  data: join(ROOT, 'data'),
  browserProfile: join(ROOT, 'data', 'browser-profile'),
  database: join(ROOT, 'data', 'jobs.db'),
  debug: join(ROOT, 'data', 'debug'),
  logs: join(ROOT, 'logs'),
};

// Job profiles live in `config`; the user's own files in `data`.
export interface Dirs {
  config: string;
  data: string;
}

export const DEFAULT_DIRS: Dirs = { config: paths.config, data: paths.data };

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
const optionalText = z.string().trim().default('');

const aliasesAreOwnSkills = (skills: string[], aliases: Record<string, string[]>) => {
  const own = new Set(skills.map((s) => s.toLowerCase()));
  return Object.keys(aliases).every((skill) => own.has(skill.toLowerCase()));
};

// Strict objects so a misspelled key fails loudly instead of silently falling back to a default.
export const userProfileSchema = z
  .strictObject({
    firstName: text,
    lastName: optionalText,
    email: optionalText,
    phone: optionalText,
    location: optionalText,
    preferredLocations: textList.default([]),
    experienceYears: z.number().min(0).max(60),
    experienceToleranceMonths: z.number().int().min(0).max(60).default(6),
    currentRole: optionalText,
    currentCompany: optionalText,
    noticePeriodDays: z.number().int().min(0).max(365).nullable().default(null),
    currentSalary: optionalText,
    expectedSalary: optionalText,
    skills: textList.min(1, 'Add at least one skill'),
    otherSkills: textList.default([]),
    // Built-in aliases (LLM = Large Language Models, ...) live in src/jobs/skills.ts.
    skillAliases: z.record(text, textList).default({}),
    resumeFile: z.string().trim().regex(/^[^/\\]+$/, 'a file name in data/resume').nullable().default(null),
  })
  .refine((p) => aliasesAreOwnSkills([...p.skills, ...p.otherSkills], p.skillAliases), {
    message: 'Every skillAliases key must be one of your skills',
    path: ['skillAliases'],
  }) satisfies z.ZodType<UserProfile, unknown>;

// config/profile.json and config/resume.json from before the dashboard's Profile page. Still read
// when data/user-profile.json doesn't exist yet.
const legacyProfileSchema = z
  .strictObject({
    name: text,
    experienceYears: z.number().min(0).max(60),
    primarySkills: textList.min(1),
    secondarySkills: textList.default([]),
    preferredLocations: textList.min(1),
    skillAliases: z.record(text, textList).default({}),
    targetRoles: textList.optional(),
    minimumExperience: z.number().optional(),
    maximumExperience: z.number().optional(),
  })
  .refine((p) => aliasesAreOwnSkills([...p.primarySkills, ...p.secondarySkills], p.skillAliases), {
    message: 'Every skillAliases key must be one of your primarySkills or secondarySkills',
    path: ['skillAliases'],
  });

const legacyResumeSchema = z.strictObject({
  resumePath: text,
  resumeName: text.optional(),
  email: text.optional(),
  phone: text.optional(),
  currentTitle: text,
  currentLocation: optionalText,
  noticePeriodDays: z.number().int().min(0).max(365),
  expectedSalary: optionalText,
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

export type JobProfile = z.infer<typeof jobProfilesSchema>[number];
export type Answer = SavedAnswer;

// What matching needs to know about the candidate. The split into primary and secondary skills and
// the locations are part of the AI cache key, so they keep the shape older profiles had.
export interface Profile {
  name: string;
  experienceYears: number;
  primarySkills: string[];
  secondarySkills: string[];
  preferredLocations: string[];
  skillAliases: Record<string, string[]>;
}

// Paths of values still holding YOUR_* template text, so they never reach an application form.
function findPlaceholders(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return /\bYOUR_[A-Z_]+/.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => findPlaceholders(item, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findPlaceholders(item, path ? `${path}.${key}` : key));
  }
  return [];
}

// "data/user-profile.json" for files in the project, the full path for anything else.
function shown(file: string): string {
  const inProject = relative(ROOT, file);
  return inProject && !inProject.startsWith('..') ? inProject : file;
}

function readConfig<T extends z.ZodType>(dir: string, file: string, schema: T): z.infer<T> {
  const path = join(dir, file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError(`${shown(path)} not found`);
    throw new ConfigError(`Cannot read ${shown(path)}: ${(err as Error).message}`);
  }

  const placeholders = findPlaceholders(raw);
  if (placeholders.length) {
    throw new ConfigError(`${shown(path)} still has template values at: ${placeholders.join(', ')}. Replace them with your own.`);
  }

  const result = schema.safeParse(raw);
  if (!result.success) throw new ConfigError(`Invalid ${shown(path)}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

// Written whole to a temporary file first, so a crash never leaves half a profile behind.
function writeJson(dir: string, file: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, file);
  writeFileSync(`${target}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
}

export interface LoadedProfile {
  profile: UserProfile;
  source: 'data' | 'legacy';
  resumePath: string | null;
}

function legacyProfile(configDir: string): LoadedProfile {
  const old = readConfig(configDir, 'profile.json', legacyProfileSchema);
  const resume = existsSync(join(configDir, 'resume.json')) ? readConfig(configDir, 'resume.json', legacyResumeSchema) : null;
  const [firstName = old.name, ...rest] = old.name.split(/\s+/);
  return {
    source: 'legacy',
    resumePath: resume ? resolve(ROOT, resume.resumePath) : null,
    profile: {
      firstName,
      lastName: rest.join(' '),
      email: resume?.email ?? '',
      phone: resume?.phone ?? '',
      location: resume?.currentLocation ?? '',
      preferredLocations: old.preferredLocations,
      experienceYears: old.experienceYears,
      experienceToleranceMonths: 6,
      currentRole: resume?.currentTitle ?? '',
      currentCompany: '',
      noticePeriodDays: resume?.noticePeriodDays ?? null,
      currentSalary: '',
      expectedSalary: resume?.expectedSalary ?? '',
      skills: old.primarySkills,
      otherSkills: old.secondarySkills,
      skillAliases: old.skillAliases,
      resumeFile: null,
    },
  };
}

const resumeDir = (dirs: Dirs) => join(dirs.data, 'resume');

// data/user-profile.json, or the older config/profile.json; null when there is neither yet.
export function loadUserProfile(dirs: Dirs = DEFAULT_DIRS): LoadedProfile | null {
  if (existsSync(join(dirs.data, 'user-profile.json'))) {
    const profile = readConfig(dirs.data, 'user-profile.json', userProfileSchema);
    return { profile, source: 'data', resumePath: profile.resumeFile ? join(resumeDir(dirs), profile.resumeFile) : null };
  }
  return existsSync(join(dirs.config, 'profile.json')) ? legacyProfile(dirs.config) : null;
}

export function requireUserProfile(dirs: Dirs = DEFAULT_DIRS): LoadedProfile {
  const loaded = loadUserProfile(dirs);
  if (!loaded) throw new ConfigError('Set up your profile first: open the dashboard and fill in the Profile page.');
  return loaded;
}

// Saves the Profile page. A resume the older config pointed at is copied into data/resume/ the first time.
export function saveUserProfile(input: unknown, dirs: Dirs = DEFAULT_DIRS): UserProfile {
  const result = userProfileSchema.safeParse(input);
  if (!result.success) throw new ConfigError(z.prettifyError(result.error));
  const profile = result.data;
  const current = loadUserProfile(dirs);
  if (!profile.resumeFile && current?.source === 'legacy' && current.resumePath && existsSync(current.resumePath)) {
    mkdirSync(resumeDir(dirs), { recursive: true });
    profile.resumeFile = basename(current.resumePath);
    copyFileSync(current.resumePath, join(resumeDir(dirs), profile.resumeFile));
  }
  if (profile.resumeFile && !existsSync(join(resumeDir(dirs), profile.resumeFile))) profile.resumeFile = null;
  writeJson(dirs.data, 'user-profile.json', profile);
  return profile;
}

const RESUME_TYPES = new Set(['.pdf', '.doc', '.docx']);
export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

// Stores an uploaded resume in data/resume/, replacing the previous one, and returns its file name.
export function saveResume(name: string, data: Buffer, dirs: Dirs = DEFAULT_DIRS): string {
  const file = basename(name).replace(/[^\w.() -]+/g, '_').trim();
  if (!RESUME_TYPES.has(extname(file).toLowerCase())) throw new ConfigError('The resume must be a PDF or Word file (.pdf, .doc, .docx)');
  if (!data.length) throw new ConfigError('The resume file is empty');
  if (data.length > MAX_RESUME_BYTES) throw new ConfigError('The resume must be 5 MB or smaller');
  const dir = resumeDir(dirs);
  mkdirSync(dir, { recursive: true });
  for (const old of readdirSync(dir)) if (old !== file) unlinkSync(join(dir, old));
  writeFileSync(join(dir, file), data, { mode: 0o600 });
  return file;
}

export function resumeInfo(path: string | null): { name: string; size: number } | null {
  return path && existsSync(path) ? { name: basename(path), size: statSync(path).size } : null;
}

// The matching view of the profile.
export function matchProfile(user: UserProfile): Profile {
  return {
    name: [user.firstName, user.lastName].filter(Boolean).join(' '),
    experienceYears: user.experienceYears,
    primarySkills: user.skills,
    secondarySkills: user.otherSkills,
    preferredLocations: user.preferredLocations.length ? user.preferredLocations : [user.location].filter(Boolean),
    skillAliases: user.skillAliases,
  };
}

export function loadProfile(dirs: Dirs = DEFAULT_DIRS): Profile {
  return matchProfile(requireUserProfile(dirs).profile);
}

// config/job-profiles.json when you have one, otherwise the defaults in job-profiles.example.json.
export function loadJobProfiles(dir = paths.config): JobProfile[] {
  const file = existsSync(join(dir, 'job-profiles.json')) ? 'job-profiles.json' : 'job-profiles.example.json';
  return readConfig(dir, file, jobProfilesSchema);
}

// data/answers.json, or the older config/answers.json; none yet is an empty list.
export function loadAnswers(dirs: Dirs = DEFAULT_DIRS): Answer[] {
  for (const dir of [dirs.data, dirs.config]) {
    if (existsSync(join(dir, 'answers.json'))) return readConfig(dir, 'answers.json', answersSchema);
  }
  return [];
}

export function saveAnswers(input: unknown, dirs: Dirs = DEFAULT_DIRS): Answer[] {
  const result = answersSchema.safeParse(input);
  if (!result.success) throw new ConfigError(z.prettifyError(result.error));
  writeJson(dirs.data, 'answers.json', result.data);
  return result.data;
}
