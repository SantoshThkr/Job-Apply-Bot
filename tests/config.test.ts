import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  ROOT,
  answersSchema,
  jobProfilesSchema,
  loadEnv,
  loadJobProfiles,
  loadProfile,
  loadResume,
  paths,
  profileSchema,
  resumeSchema,
} from '../src/config.ts';

// Tests use only the public templates; config/*.json holds personal data and is not in the repo.
const example = (file: string) => JSON.parse(readFileSync(join(paths.config, file), 'utf8'));
const validProfile = { ...example('profile.example.json'), name: 'Test Candidate' };

function configDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'naukri-bot-config-'));
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

describe('loadEnv', () => {
  it('defaults to the safe settings', () => {
    const env = loadEnv({});
    expect(env.AUTO_APPLY).toBe(false);
    expect(env.DEBUG_SCREENSHOTS).toBe(false);
    expect(env.HEADLESS).toBe(false);
    expect(env.BROWSER_CHANNEL).toBe('chrome');
    expect(env.MIN_MATCH_SCORE).toBe(75);
  });

  it('puts no cap on how many jobs a run handles unless you set one', () => {
    expect(loadEnv({}).MAX_JOBS_PER_RUN).toBeUndefined();
    expect(loadEnv({ MAX_JOBS_PER_RUN: '5000' }).MAX_JOBS_PER_RUN).toBe(5000);
    expect(loadEnv({}).SEARCH_MAX_PAGES).toBe(10);
  });

  it('defaults to free local analysis with Ollama and needs no API key', () => {
    expect(loadEnv({})).toMatchObject({
      AI_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'http://localhost:11434',
      OLLAMA_MODEL: 'qwen3:4b',
      AI_CONCURRENCY: 1,
      AI_MAX_ATTEMPTS: 3,
    });
    expect(loadEnv({}).OPENAI_API_KEY).toBeUndefined();
  });

  it('requires an OpenAI key only when OpenAI is chosen', () => {
    expect(() => loadEnv({ AI_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY is required when AI_PROVIDER=openai/);
    expect(loadEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' }).AI_PROVIDER).toBe('openai');
    expect(() => loadEnv({ AI_PROVIDER: 'claude' })).toThrow(/AI_PROVIDER/);
    expect(() => loadEnv({ OLLAMA_BASE_URL: 'localhost' })).toThrow(/OLLAMA_BASE_URL/);
  });

  it('parses booleans and numbers from strings', () => {
    const env = loadEnv({ AUTO_APPLY: 'true', HEADLESS: 'true', MAX_JOBS_PER_RUN: '20' });
    expect(env).toMatchObject({ AUTO_APPLY: true, HEADLESS: true, MAX_JOBS_PER_RUN: 20 });
  });

  it('treats blank values as unset', () => {
    const env = loadEnv({ OPENAI_MODEL: '', MIN_MATCH_SCORE: ' ' });
    expect(env.OPENAI_MODEL).toBe('gpt-5-mini');
    expect(env.MIN_MATCH_SCORE).toBe(75);
  });

  it('rejects values it cannot interpret instead of guessing', () => {
    expect(() => loadEnv({ AUTO_APPLY: 'maybe' })).toThrow(ConfigError);
    expect(() => loadEnv({ MAX_JOBS_PER_RUN: 'lots' })).toThrow(/MAX_JOBS_PER_RUN/);
    expect(() => loadEnv({ MIN_MATCH_SCORE: '120' })).toThrow(/MIN_MATCH_SCORE/);
    expect(() => loadEnv({ DELAY_MIN_MS: '5000', DELAY_MAX_MS: '1000' })).toThrow(/DELAY_MIN_MS/);
  });
});

describe('config files', () => {
  it('ships example templates that match the schemas', () => {
    expect(profileSchema.safeParse(example('profile.example.json')).success).toBe(true);
    expect(resumeSchema.safeParse(example('resume.example.json')).success).toBe(true);
    expect(jobProfilesSchema.safeParse(example('job-profiles.example.json')).success).toBe(true);
    expect(answersSchema.safeParse(example('answers.example.json')).success).toBe(true);
  });

  it('loads a filled-in config and resolves the resume path', () => {
    const dir = configDir({
      'profile.json': validProfile,
      'resume.json': {
        ...example('resume.example.json'),
        resumePath: './resume/cv.pdf',
        resumeName: 'cv.pdf',
        email: 'candidate@example.com',
        phone: '0000000000',
        currentTitle: 'Engineer',
        currentLocation: 'Pune',
      },
    });
    expect(loadProfile(dir).name).toBe('Test Candidate');
    expect(loadResume(dir).resumePath).toBe(join(ROOT, 'resume', 'cv.pdf'));
  });

  it('refuses a config that still has template values', () => {
    const dir = configDir({ 'resume.json': example('resume.example.json') });
    expect(() => loadResume(dir)).toThrow(/template values at: resumePath, resumeName, email, phone, currentTitle, currentLocation/);
  });

  it('explains how to create a missing config', () => {
    expect(() => loadProfile(configDir({}))).toThrow(/Copy config\/profile\.example\.json to config\/profile\.json/);
  });

  it('still loads an older profile.json with experience limits and target roles, which no longer filter anything', () => {
    const older = { ...validProfile, targetRoles: ['AI Engineer'], minimumExperience: 12, maximumExperience: 6 };
    expect(loadProfile(configDir({ 'profile.json': older })).name).toBe('Test Candidate');
  });

  it('rejects misspelled keys', () => {
    const { experienceYears, ...rest } = validProfile;
    const dir = configDir({ 'profile.json': { ...rest, experienceYear: experienceYears } });
    expect(() => loadProfile(dir)).toThrow(ConfigError);
  });

  it('only accepts skill aliases for skills in the profile', () => {
    const ok = configDir({ 'profile.json': { ...validProfile, skillAliases: { React: ['Preact'] } } });
    expect(loadProfile(ok).skillAliases).toEqual({ React: ['Preact'] });
    const bad = configDir({ 'profile.json': { ...validProfile, skillAliases: { Rust: ['Tokio'] } } });
    expect(() => loadProfile(bad)).toThrow(/skillAliases key must be one of your/);
  });

  it('ships the seven job profiles, and prefers your own job-profiles.json', () => {
    const shipped = example('job-profiles.example.json');
    expect(loadJobProfiles(configDir({ 'job-profiles.example.json': shipped })).map((p) => p.name)).toEqual([
      'Frontend Developer',
      'React.js Developer',
      'Angular Developer',
      'Web Developer',
      'Full Stack Developer',
      'Full Stack AI Engineer',
      'All / Broad Software & Web',
    ]);
    const own = [{ id: 'vue', name: 'Vue Developer', keywords: ['Vue Developer'] }];
    const dir = configDir({ 'job-profiles.example.json': shipped, 'job-profiles.json': own });
    expect(loadJobProfiles(dir)).toEqual([{ ...own[0], skills: [], exclude: [], ai: false }]);
  });

  it('rejects duplicate job profile ids', () => {
    const profile = { id: 'react', name: 'React', keywords: ['React Developer'] };
    const dir = configDir({ 'job-profiles.json': [profile, { ...profile, name: 'React again' }] });
    expect(() => loadJobProfiles(dir)).toThrow(/unique/);
  });

  it('names the file when JSON is malformed', () => {
    const dir = configDir({ 'job-profiles.json': '[{' });
    expect(() => loadJobProfiles(dir)).toThrow(/config\/job-profiles\.json/);
  });
});
