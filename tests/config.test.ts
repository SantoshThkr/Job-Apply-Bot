import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, ROOT, loadEnv, loadProfile, loadResume, loadSearches, paths } from '../src/config.ts';

const shippedProfile = JSON.parse(readFileSync(join(paths.config, 'profile.json'), 'utf8'));

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
  it('loads the shipped profile, resume and searches', () => {
    expect(loadProfile().name).toBe('Santosh Thakur');
    expect(loadSearches().map((s) => s.name)).toEqual(['Full Stack AI', 'React AI', 'Senior Frontend']);
    expect(loadResume().resumePath).toBe(join(ROOT, 'resume', 'Santosh-Thakur-Resume.pdf'));
  });

  it('rejects an inverted experience range', () => {
    const dir = configDir({ 'profile.json': { ...shippedProfile, minimumExperience: 12, maximumExperience: 6 } });
    expect(() => loadProfile(dir)).toThrow(/minimumExperience must not exceed/);
  });

  it('rejects misspelled keys', () => {
    const { minimumExperience, ...rest } = shippedProfile;
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
