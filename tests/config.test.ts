import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  ROOT,
  answersSchema,
  loadEnv,
  loadProfile,
  loadResume,
  loadSearches,
  paths,
  profileSchema,
  resumeSchema,
  searchesSchema,
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
    expect(env.STOP_BEFORE_SUBMIT).toBe(true);
    expect(env.HEADLESS).toBe(false);
    expect(env.BROWSER_CHANNEL).toBe('chrome');
    expect(env.MAX_JOBS_PER_RUN).toBe(50);
    expect(env.MIN_MATCH_SCORE).toBe(75);
  });

  it('parses booleans and numbers from strings', () => {
    const env = loadEnv({ STOP_BEFORE_SUBMIT: 'false', HEADLESS: 'true', MAX_JOBS_PER_RUN: '20' });
    expect(env).toMatchObject({ STOP_BEFORE_SUBMIT: false, HEADLESS: true, MAX_JOBS_PER_RUN: 20 });
  });

  it('treats blank values as unset', () => {
    const env = loadEnv({ OPENAI_MODEL: '', MIN_MATCH_SCORE: ' ' });
    expect(env.OPENAI_MODEL).toBeUndefined();
    expect(env.MIN_MATCH_SCORE).toBe(75);
  });

  it('rejects values it cannot interpret instead of guessing', () => {
    expect(() => loadEnv({ STOP_BEFORE_SUBMIT: 'maybe' })).toThrow(ConfigError);
    expect(() => loadEnv({ MAX_JOBS_PER_RUN: 'lots' })).toThrow(/MAX_JOBS_PER_RUN/);
    expect(() => loadEnv({ MIN_MATCH_SCORE: '120' })).toThrow(/MIN_MATCH_SCORE/);
    expect(() => loadEnv({ DELAY_MIN_MS: '5000', DELAY_MAX_MS: '1000' })).toThrow(/DELAY_MIN_MS/);
  });
});

describe('config files', () => {
  it('ships example templates that match the schemas', () => {
    expect(profileSchema.safeParse(example('profile.example.json')).success).toBe(true);
    expect(resumeSchema.safeParse(example('resume.example.json')).success).toBe(true);
    expect(searchesSchema.safeParse(example('searches.example.json')).success).toBe(true);
    expect(answersSchema.safeParse(example('answers.example.json')).success).toBe(true);
  });

  it('loads a filled-in config and resolves the resume path', () => {
    const dir = configDir({
      'profile.json': validProfile,
      'resume.json': { ...example('resume.example.json'), resumePath: './resume/cv.pdf', resumeName: 'cv.pdf', currentTitle: 'Engineer', currentLocation: 'Pune' },
    });
    expect(loadProfile(dir).name).toBe('Test Candidate');
    expect(loadResume(dir).resumePath).toBe(join(ROOT, 'resume', 'cv.pdf'));
  });

  it('refuses a config that still has template values', () => {
    const dir = configDir({ 'resume.json': example('resume.example.json') });
    expect(() => loadResume(dir)).toThrow(/template values at: resumePath, resumeName, currentTitle, currentLocation/);
  });

  it('explains how to create a missing config', () => {
    expect(() => loadProfile(configDir({}))).toThrow(/Copy config\/profile\.example\.json to config\/profile\.json/);
  });

  it('rejects an inverted experience range', () => {
    const dir = configDir({ 'profile.json': { ...validProfile, minimumExperience: 12, maximumExperience: 6 } });
    expect(() => loadProfile(dir)).toThrow(/minimumExperience must not exceed/);
  });

  it('rejects misspelled keys', () => {
    const { minimumExperience, ...rest } = validProfile;
    const dir = configDir({ 'profile.json': { ...rest, minimumExperiance: minimumExperience } });
    expect(() => loadProfile(dir)).toThrow(ConfigError);
  });

  it('rejects duplicate search names', () => {
    const search = { name: 'React', keywords: ['React Developer'] };
    const dir = configDir({ 'searches.json': [search, { ...search, name: 'react' }] });
    expect(() => loadSearches(dir)).toThrow(/unique/);
  });

  it('names the file when JSON is malformed', () => {
    const dir = configDir({ 'searches.json': '[{' });
    expect(() => loadSearches(dir)).toThrow(/config\/searches\.json/);
  });
});
