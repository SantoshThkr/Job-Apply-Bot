import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const paths = {
  config: join(ROOT, 'config'),
  browserProfile: join(ROOT, 'data', 'browser-profile'),
  debug: join(ROOT, 'data', 'debug'),
  logs: join(ROOT, 'logs'),
};

export class ConfigError extends Error {
  name = 'ConfigError';
}

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const envSchema = z
  .object({
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().optional(),
    HEADLESS: z.stringbool().default(false),
    BROWSER_CHANNEL: z.enum(['chrome', 'chromium']).default('chrome'),
    MIN_MATCH_SCORE: int(0, 100).default(75),
    AUTO_FILL: z.stringbool().default(true),
    STOP_BEFORE_SUBMIT: z.stringbool().default(true),
    MAX_JOBS_PER_RUN: int(1, 500).default(50),
    DELAY_MIN_MS: int(0, 60_000).default(1500),
    DELAY_MAX_MS: int(0, 60_000).default(4000),
  })
  .refine((env) => env.DELAY_MIN_MS <= env.DELAY_MAX_MS, {
    message: 'DELAY_MIN_MS must not exceed DELAY_MAX_MS',
    path: ['DELAY_MAX_MS'],
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
    experienceYears: z.number().min(0).max(60),
    targetRoles: textList.min(1),
    primarySkills: textList.min(1),
    secondarySkills: textList.default([]),
    preferredLocations: textList.min(1),
    minimumExperience: z.number().min(0),
    maximumExperience: z.number().min(0),
  })
  .refine((profile) => profile.minimumExperience <= profile.maximumExperience, {
    message: 'minimumExperience must not exceed maximumExperience',
    path: ['maximumExperience'],
  });

export const resumeSchema = z.strictObject({
  resumePath: text,
  resumeName: text.optional(),
  currentTitle: text,
  currentLocation: z.string().trim().default(''),
  noticePeriodDays: z.number().int().min(0).max(365),
  expectedSalary: z.string().trim().default(''),
  education: textList.default([]),
  preferredWorkMode: z.array(z.enum(['Remote', 'Hybrid', 'Office'])).default([]),
});

export const searchesSchema = z
  .array(
    z.strictObject({
      name: text,
      keywords: textList.min(1),
      // Falls back to profile.preferredLocations when omitted.
      locations: textList.optional(),
    }),
  )
  .min(1)
  .refine((searches) => new Set(searches.map((s) => s.name.toLowerCase())).size === searches.length, {
    message: 'Search names must be unique',
  });

export type Profile = z.infer<typeof profileSchema>;
export type Resume = z.infer<typeof resumeSchema>;
export type Search = z.infer<typeof searchesSchema>[number];

function readConfig<T extends z.ZodType>(dir: string, file: string, schema: T): z.infer<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read config/${file}: ${(err as Error).message}`);
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

export function loadSearches(dir = paths.config): Search[] {
  return readConfig(dir, 'searches.json', searchesSchema);
}
