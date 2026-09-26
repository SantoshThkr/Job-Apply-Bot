import { describe, expect, it } from 'vitest';
import { privatePathReason, scanContent } from '../scripts/scan-secrets.ts';

// Fake secrets are assembled at runtime so this file doesn't trip the scanner itself.
const fake = {
  openAiKey: 'sk-' + 'proj-' + 'a1B2'.repeat(10),
  jwt: ['eyJ' + 'h'.repeat(12), 'eyJ' + 'p'.repeat(12), 's'.repeat(20)].join('.'),
  email: 'jane.doe' + '@' + 'gmail.com',
  phone: '98765' + '43210',
};

const reasons = (text: string) => scanContent('file.ts', text).map((f) => `${f.severity}:${f.reason}`);

describe('privatePathReason', () => {
  it.each([
    '.env',
    '.env.local',
    'data/browser-profile/Default/Cookies',
    'config/profile.json',
    'config/answers.json',
    'data/user-profile.json',
    'data/answers.json',
    'data/resume/cv.pdf',
    'data/jobs.db-wal',
    'user-profile.json',
    'resume/cv.pdf',
    'jobs.sqlite',
    'logs/2026-09-25.log',
    'debug/trace.zip',
    'storage-state.json',
  ])('blocks %s', (path) => {
    expect(privatePathReason(path)).toBeDefined();
  });

  it.each(['.env.example', 'config/job-profiles.example.json', 'data/user-profile.example.json', 'data/answers.example.json', 'resume/README.md', 'src/browser/session.ts', 'README.md'])(
    'allows %s',
    (path) => {
      expect(privatePathReason(path)).toBeUndefined();
    },
  );
});

describe('scanContent', () => {
  it('blocks credentials', () => {
    expect(reasons(`const key = "${fake.openAiKey}";`)).toContain('block:OpenAI API key');
    expect(reasons('OPENAI_API_KEY=abc123')).toContain('block:OPENAI_API_KEY with a value');
    expect(reasons(`Authorization: Bearer ${fake.jwt}`)).toEqual(expect.arrayContaining(['block:bearer token', 'block:JWT']));
    expect(reasons(`nauk_at=${'x'.repeat(24)}`)).toContain('block:Naukri session cookie');
    expect(reasons(`password: "${'hunter2'}"`)).toContain('block:hard-coded password');
  });

  it('warns about personal contact details', () => {
    expect(reasons(`contact: ${fake.email}`)).toEqual(['warn:email address']);
    expect(reasons(`phone: +91 ${fake.phone}`)).toEqual(['warn:phone number']);
  });

  it('ignores code that only mentions sensitive words', () => {
    const benign = [
      'OPENAI_API_KEY=',
      'OPENAI_API_KEY: z.string().optional(),',
      "const apiKey = process.env.OPENAI_API_KEY;",
      "page.locator('#passwordField')",
      '// Closing the context is what flushes cookies to data/browser-profile.',
      'Contact: jane@example.com',
      'const timeoutMs = 45000;',
      '"resolved": "https://registry.npmjs.org/@types/node/-/node-24.13.6.tgz"',
    ].join('\n');
    expect(scanContent('file.ts', benign)).toEqual([]);
  });
});
