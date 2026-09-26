import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  answersSchema,
  jobProfilesSchema,
  loadAnswers,
  loadEnv,
  loadJobProfiles,
  loadProfile,
  loadUserProfile,
  matchProfile,
  paths,
  requireUserProfile,
  saveAnswers,
  saveResume,
  saveUserProfile,
  userProfileSchema,
} from '../src/config.ts';

// Tests use only the public templates in temporary folders; the real data/ and config/ files hold
// personal details and are never read here.
const template = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const exampleProfile = template(paths.data, 'user-profile.example.json');
const validProfile = {
  ...exampleProfile,
  firstName: 'Test',
  lastName: 'Candidate',
  email: 'candidate@example.com',
  phone: '0000000000',
  location: 'Pune',
  preferredLocations: ['Remote', 'Pune'],
  currentRole: 'Engineer',
  currentCompany: 'Example Co',
};

function folder(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'naukri-bot-config-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const dirs = (data: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({ data: folder(data), config: folder(config) });

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

describe('user profile', () => {
  it('ships templates that match the schemas', () => {
    expect(userProfileSchema.safeParse(exampleProfile).success).toBe(true);
    expect(answersSchema.safeParse(template(paths.data, 'answers.example.json')).success).toBe(true);
    expect(jobProfilesSchema.safeParse(template(paths.config, 'job-profiles.example.json')).success).toBe(true);
  });

  it('loads data/user-profile.json with its resume in data/resume', () => {
    const where = dirs({ 'user-profile.json': { ...validProfile, resumeFile: 'cv.pdf' }, 'resume/cv.pdf': 'pdf' });
    expect(loadUserProfile(where)).toEqual({
      source: 'data',
      resumePath: join(where.data, 'resume', 'cv.pdf'),
      profile: { ...validProfile, resumeFile: 'cv.pdf' },
    });
    expect(loadProfile(where)).toMatchObject({ name: 'Test Candidate', primarySkills: exampleProfile.skills, secondarySkills: exampleProfile.otherSkills });
  });

  it('refuses a profile that still has template values', () => {
    expect(() => loadUserProfile(dirs({ 'user-profile.json': exampleProfile }))).toThrow(/template values at: firstName, lastName, email, phone, location/);
  });

  it('asks for a profile when there is none', () => {
    expect(loadUserProfile(dirs())).toBeNull();
    expect(() => requireUserProfile(dirs())).toThrow(/Set up your profile first/);
  });

  it('still reads the older config/profile.json and resume.json, keeping the skill lists as they were', () => {
    const where = dirs(
      {},
      {
        'profile.json': {
          name: 'Test Candidate',
          experienceYears: 7,
          primarySkills: ['React'],
          secondarySkills: ['Docker'],
          preferredLocations: ['Remote', 'Pune'],
          targetRoles: ['Engineer'],
          minimumExperience: 6,
        },
        'resume.json': { resumePath: './resume/cv.pdf', currentTitle: 'Engineer', noticePeriodDays: 30, email: 'candidate@example.com' },
      },
    );
    const loaded = loadUserProfile(where)!;
    expect(loaded.source).toBe('legacy');
    expect(loaded.profile).toMatchObject({
      firstName: 'Test',
      lastName: 'Candidate',
      email: 'candidate@example.com',
      experienceYears: 7,
      experienceToleranceMonths: 6,
      currentRole: 'Engineer',
      noticePeriodDays: 30,
    });
    // Primary and secondary skills and the locations feed the AI cache key, so cached analyses stay valid.
    expect(matchProfile(loaded.profile)).toEqual({
      name: 'Test Candidate',
      experienceYears: 7,
      primarySkills: ['React'],
      secondarySkills: ['Docker'],
      preferredLocations: ['Remote', 'Pune'],
      skillAliases: {},
    });
  });

  it('saves the profile to data/, copying a resume the older config pointed at', () => {
    const where = dirs({}, { 'profile.json': { name: 'Test', experienceYears: 5, primarySkills: ['React'], preferredLocations: ['Pune'] } });
    const resume = join(where.config, 'old-cv.pdf');
    writeFileSync(resume, 'pdf');
    writeFileSync(join(where.config, 'resume.json'), JSON.stringify({ resumePath: resume, currentTitle: 'Engineer', noticePeriodDays: 30 }));

    const saved = saveUserProfile({ ...validProfile, resumeFile: null }, where);
    expect(saved.resumeFile).toBe('old-cv.pdf');
    expect(readFileSync(join(where.data, 'resume', 'old-cv.pdf'), 'utf8')).toBe('pdf');
    expect(loadUserProfile(where)).toMatchObject({ source: 'data', profile: { firstName: 'Test', resumeFile: 'old-cv.pdf' } });
    expect(() => saveUserProfile({ ...validProfile, experienceYears: 'seven' }, where)).toThrow(ConfigError);
    expect(() => saveUserProfile({ ...validProfile, skills: [] }, where)).toThrow(/at least one skill/);
  });

  it('stores one resume, replacing the last, and only PDF or Word files', () => {
    const where = dirs();
    expect(saveResume('My CV.pdf', Buffer.from('one'), where)).toBe('My CV.pdf');
    expect(saveResume('../../cv-2.docx', Buffer.from('two'), where)).toBe('cv-2.docx');
    expect(readdirSync(join(where.data, 'resume'))).toEqual(['cv-2.docx']);
    expect(() => saveResume('cv.exe', Buffer.from('x'), where)).toThrow(/PDF or Word/);
    expect(() => saveResume('cv.pdf', Buffer.alloc(6 * 1024 * 1024), where)).toThrow(/5 MB/);
  });

  it('reads answers from data/, then from the older config/', () => {
    const answers = [{ match: ['relocate'], answer: 'Yes' }];
    expect(loadAnswers(dirs())).toEqual([]);
    expect(loadAnswers(dirs({}, { 'answers.json': answers }))).toEqual(answers);
    const where = dirs({}, { 'answers.json': [{ match: ['old'], answer: 'Old' }] });
    saveAnswers(answers, where);
    expect(loadAnswers(where)).toEqual(answers);
    expect(() => saveAnswers([{ match: [], answer: 'x' }], where)).toThrow(ConfigError);
  });

  it('only accepts skill aliases for skills in the profile', () => {
    expect(userProfileSchema.safeParse({ ...validProfile, skillAliases: { React: ['Preact'] } }).success).toBe(true);
    expect(() => saveUserProfile({ ...validProfile, skillAliases: { Rust: ['Tokio'] } }, dirs())).toThrow(/skillAliases key must be one of your skills/);
  });
});

describe('job profiles', () => {
  it('ships the seven job profiles, and prefers your own job-profiles.json', () => {
    const shipped = template(paths.config, 'job-profiles.example.json');
    expect(loadJobProfiles(folder({ 'job-profiles.example.json': shipped })).map((p) => p.name)).toEqual([
      'Frontend Developer',
      'React.js Developer',
      'Angular Developer',
      'Web Developer',
      'Full Stack Developer',
      'Full Stack AI Engineer',
      'All / Broad Software & Web',
    ]);
    const own = [{ id: 'vue', name: 'Vue Developer', keywords: ['Vue Developer'] }];
    const dir = folder({ 'job-profiles.example.json': shipped, 'job-profiles.json': own });
    expect(loadJobProfiles(dir)).toEqual([{ ...own[0], skills: [], exclude: [], ai: false }]);
  });

  it('rejects duplicate job profile ids', () => {
    const profile = { id: 'react', name: 'React', keywords: ['React Developer'] };
    const dir = folder({ 'job-profiles.json': [profile, { ...profile, name: 'React again' }] });
    expect(() => loadJobProfiles(dir)).toThrow(/unique/);
  });

  it('names the file when JSON is malformed', () => {
    const dir = folder({ 'job-profiles.json': '[{' });
    expect(() => loadJobProfiles(dir)).toThrow(/job-profiles\.json/);
  });
});
