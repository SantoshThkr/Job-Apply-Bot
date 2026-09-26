import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api.ts';
import { launchBrowser } from '../src/browser/browser.ts';
import { disableManualPauses } from '../src/browser/session.ts';
import { loadEnv, paths } from '../src/config.ts';
import { BotControl } from '../src/control.ts';
import { openDatabase } from '../src/db/database.ts';
import type { BotEvent, ProfileResponse, RunDetail, ScopeSummary } from '../src/domain.ts';
import { serveFakeNaukri, type FakeCard, type FakeJob } from './naukri-fake.ts';

const channel = process.env.BROWSER_CHANNEL === 'chromium' ? 'chromium' : 'chrome';
const scope = { profiles: ['react'], locations: ['Bangalore'], freshness: 'all', experienceYears: 7, toleranceMonths: 6 };
const start = { scope, autoApply: true };
const scopeQuery = 'profiles=react&locations=Bangalore&freshness=all&experience=7&tolerance=6';
// Not anyone's real details.
const testProfile = {
  firstName: 'Test',
  lastName: 'Candidate',
  email: 'candidate@example.com',
  phone: '0000000000',
  location: 'Bangalore',
  preferredLocations: ['Bangalore'],
  experienceYears: 7,
  experienceToleranceMonths: 6,
  currentRole: 'Engineer',
  currentCompany: 'Example Co',
  noticePeriodDays: 30,
  currentSalary: '',
  expectedSalary: '',
  skills: ['React', 'TypeScript'],
  otherSkills: [],
  skillAliases: {},
  resumeFile: null,
};

let db: DatabaseSync;
let control: BotControl;
let server: Server;
let port: number;
let fakeJobs: FakeJob[] = [];
let fakeSearch: FakeCard[] = [];
let dataDir: string;
const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

beforeAll(async () => {
  disableManualPauses();
  db = openDatabase(':memory:');
  // Only the shipped job profiles; no personal config.
  const configDir = tempDir('naukri-bot-config-');
  copyFileSync(join(paths.config, 'job-profiles.example.json'), join(configDir, 'job-profiles.example.json'));
  // Starts empty: the profile is set up through the API like the dashboard's Profile page does.
  dataDir = tempDir('naukri-bot-data-');
  const where = { config: configDir, data: dataDir };
  // A long wait after each Apply click gives the stop test a fixed moment to stop in.
  const env = loadEnv({ HEADLESS: 'true', APPLY_DELAY_MS: '20000', DELAY_MIN_MS: '0', DELAY_MAX_MS: '0' });
  control = new BotControl({
    db,
    env,
    dirs: where,
    waitMs: 2_000,
    launch: async () => {
      const context: BrowserContext = await launchBrowser({ headless: true, channel, profileDir: tempDir('naukri-bot-api-') });
      await serveFakeNaukri(context, () => fakeJobs, { search: () => fakeSearch });
      return context;
    },
  });
  server = createApi({ control, db, env, dirs: where });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await control.shutdown({ graceMs: 5_000 });
  server.closeAllConnections();
  server.close();
  db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function call(method: string, path: string, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// Collects SSE events until `until` returns true.
function listen(until: (events: BotEvent[]) => boolean) {
  const received: BotEvent[] = [];
  let close = () => {};
  const done = new Promise<BotEvent[]>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        const frames = buffer.split('\n\n');
        buffer = frames.pop()!;
        for (const frame of frames) {
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) received.push(JSON.parse(data.slice(6)));
        }
        if (until(received)) {
          req.destroy();
          resolve(received);
        }
      });
    });
    req.on('error', (err) => (err.message === 'socket hang up' ? resolve(received) : reject(err)));
    req.end();
    close = () => req.destroy();
  });
  return { done, close: () => close() };
}

describe('local-only guard', () => {
  it('rejects other hosts, other origins and non-JSON writes', async () => {
    expect((await call('GET', '/api/health', { headers: { Host: 'evil.example' } })).status).toBe(403);
    expect((await call('POST', '/api/runs/stop', { body: {}, headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call('POST', '/api/runs/stop', { headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await call('GET', '/api/health', { headers: { Origin: 'http://localhost:3000' } })).status).toBe(200);
  });
});

describe('dashboard API', () => {
  it('reports status, profiles and what is missing, without secrets', async () => {
    const status = await call('GET', '/api/status');
    expect(status.body).toMatchObject({
      state: { session: 'UNKNOWN', browser: 'STOPPED', activity: null, activeRun: null },
      ai: { provider: 'Ollama', model: 'qwen3:4b' },
      profileReady: false,
    });
    const profiles = (await call('GET', '/api/profiles')).body;
    expect(profiles.map((p: { name: string }) => p.name)).toContain('Frontend Developer');
    const summary: ScopeSummary = (await call('GET', `/api/summary?${scopeQuery}`)).body;
    expect(summary).toMatchObject({ found: 0, eligible: 0, queued: 0, minMatchScore: 75 });
    expect(summary.problems.join('\n')).toMatch(/Set up your profile/);
    expect((await call('POST', '/api/runs/start', { body: start })).body.error).toMatch(/Set up your profile first/);
    expect(JSON.stringify([status.body, summary])).not.toMatch(/OPENAI_API_KEY|apiKey/);
  });

  it('saves the profile, answers and resume in the data folder', async () => {
    const answers = [{ match: ['relocate'], answer: 'Yes' }];
    expect((await call('POST', '/api/profile', { body: { profile: { ...testProfile, skills: [] }, answers } })).status).toBe(400);
    const saved: ProfileResponse = (await call('POST', '/api/profile', { body: { profile: testProfile, answers } })).body;
    expect(saved).toMatchObject({ ready: true, source: 'data', answers, defaults: { locations: ['Bangalore'], experienceYears: 7, toleranceMonths: 6 } });
    expect(saved.problems).toEqual(['No resume uploaded: forms that ask for one go to Review.']);

    const resume = { name: 'cv.pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') };
    expect((await call('POST', '/api/profile/resume', { body: { ...resume, name: 'cv.exe' } })).status).toBe(400);
    expect((await call('POST', '/api/profile/resume', { body: resume })).body).toEqual({ file: 'cv.pdf' });
    const loaded: ProfileResponse = (await call('GET', '/api/profile')).body;
    expect(loaded).toMatchObject({ profile: { resumeFile: 'cv.pdf' }, resume: { name: 'cv.pdf' }, problems: [] });
    expect(readFileSync(join(dataDir, 'resume', 'cv.pdf'), 'utf8')).toBe('%PDF-1.4 test');
    expect((await call('GET', '/api/status')).body.profileReady).toBe(true);
  });

  it('validates input', async () => {
    expect((await call('GET', '/api/jobs?status=bogus')).status).toBe(400);
    expect((await call('GET', '/api/jobs?freshness=yesterday')).status).toBe(400);
    expect((await call('GET', '/api/summary?freshness=custom&from=2026-09-26&to=2026-09-20')).status).toBe(400);
    expect((await call('POST', '/api/runs/start', { body: { ...start, maxApplications: 20 } })).status).toBe(400);
    expect((await call('POST', '/api/runs/start', { body: { scope } })).status).toBe(400);
    expect((await call('POST', '/api/runs/start', { body: { ...start, scope: { ...scope, freshness: 'custom' } } })).body.error).toMatch(/start date/);
    expect((await call('GET', '/api/runs/RUN-20990101-000000')).status).toBe(404);
    expect((await call('POST', '/api/runs/stop', { body: {} })).status).toBe(409);
    expect((await call('POST', '/api/runs/pause', { body: {} })).status).toBe(409);
  });

  it('starts from one request: searches, then applies to every eligible job and streams it live', async () => {
    // Beta shows the company-site button only on its page; the search data doesn't say so.
    fakeSearch = [
      { id: '200000000002', title: 'React Developer', company: 'Beta', experience: '3-6 Yrs', location: 'Bengaluru', hoursAgo: 1 },
      { id: '200000000001', title: 'React Developer', company: 'Acme', experience: '5-9 Yrs', location: 'Bengaluru', hoursAgo: 2 },
      { id: '200000000009', title: 'Senior React Developer', company: 'Senior', experience: '12-16 Yrs', location: 'Bengaluru', hoursAgo: 3 },
    ];
    fakeJobs = [
      { id: '200000000001', kind: 'one-click' },
      { id: '200000000002', kind: 'external' },
      { id: '200000000009', kind: 'one-click' },
    ];

    const stream = listen((events) => events.some((e) => e.type === 'RUN_COMPLETED'));
    const started = await call('POST', '/api/runs/start', { body: start });
    expect(started.status).toBe(202);
    const second = await call('POST', '/api/runs/start', { body: start });
    expect(second).toMatchObject({ status: 409, body: { error: expect.stringMatching(/already active/) } });

    const received = await stream.done;
    await control.idle();
    expect(received[0]).toMatchObject({ type: 'STATE' });
    const types = received.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['RUN_STARTED', 'SEARCH_FINISHED', 'QUEUE_READY', 'JOB_STARTED', 'APPLY_CLICKED', 'APPLICATION_CONFIRMED', 'EXTERNAL_APPLICATION', 'LOG']),
    );

    const run: RunDetail = (await call('GET', `/api/runs/${started.body.runId}`)).body;
    expect(run).toMatchObject({
      status: 'COMPLETED',
      attempted: 2,
      outcomes: { applied: 1, external: 1 },
      stats: { found: 3, relevant: 3, eligible: 2, queued: 2 },
    });
    expect(run.applications.map((a) => [a.company, a.status]).sort()).toEqual([
      ['Acme', 'APPLIED'],
      ['Beta', 'EXTERNAL'],
    ]);
    expect((await call('GET', `/api/runs/${run.id}?limit=1`)).body.applications).toHaveLength(1);
    const detail = (await call('GET', `/api/applications/${run.applications.find((a) => a.company === 'Acme')!.id}`)).body;
    expect(detail.events.map((e: { type: string }) => e.type)).toContain('APPLICATION_CONFIRMED');

    const state = (await call('GET', '/api/status')).body.state;
    expect(state).toMatchObject({ session: 'LOGGED_IN', browser: 'RUNNING', activity: null, activeRun: null });
    const jobs = (await call('GET', `/api/jobs?${scopeQuery}`)).body.jobs.map((j: { company: string; category: string }) => [j.company, j.category]);
    expect(jobs).toEqual([
      ['Beta', 'external'],
      ['Acme', 'applied'],
      ['Senior', 'not_eligible'],
    ]);
    const summary: ScopeSummary = (await call('GET', `/api/summary?${scopeQuery}`)).body;
    expect(summary).toMatchObject({ found: 3, eligible: 2, queued: 0, counts: { applied: 1, external: 1, not_eligible: 1 } });
  });

  it('pauses, resumes and stops a run, and refuses to close the browser meanwhile', async () => {
    fakeSearch = [
      { id: '200000000003', title: 'React Developer', company: 'Gamma', experience: '5-9 Yrs', location: 'Bengaluru', hoursAgo: 1 },
      { id: '200000000004', title: 'React Developer', company: 'Delta', experience: '5-9 Yrs', location: 'Bengaluru', hoursAgo: 2 },
    ];
    fakeJobs = [
      { id: '200000000003', kind: 'one-click' },
      { id: '200000000004', kind: 'one-click' },
    ];
    const { body } = await call('POST', '/api/runs/start', { body: start });
    // Paused before the search: nothing is opened or clicked while it waits.
    expect((await call('POST', '/api/runs/pause', { body: {} })).body.activeRun).toMatchObject({ paused: true });
    await new Promise((wait) => setTimeout(wait, 1_500));
    expect((await call('GET', `/api/runs/${body.runId}`)).body).toMatchObject({ status: 'PAUSED', attempted: 0 });
    const refused = await call('POST', '/api/browser/stop', { body: {} });
    expect(refused).toMatchObject({ status: 409, body: { error: expect.stringMatching(/Stop it before closing the browser/) } });

    const gamma = listen((events) => events.some((e) => e.type === 'APPLICATION_CONFIRMED' && e.company === 'Gamma'));
    expect((await call('POST', '/api/runs/resume', { body: {} })).body.activeRun).toMatchObject({ paused: false });
    await gamma.done;
    // Stopped during the wait after Gamma's Apply click, so Delta is never started.
    expect((await call('POST', '/api/runs/stop', { body: {} })).body.activeRun).toMatchObject({ stopRequested: true });
    await control.idle();

    const run: RunDetail = (await call('GET', `/api/runs/${body.runId}`)).body;
    expect(run).toMatchObject({ status: 'STOPPED', stopReason: 'Stopped from the dashboard', attempted: 1 });
    expect(run.applications.map((a) => [a.company, a.status])).toEqual([['Gamma', 'APPLIED']]);
    expect(run.events.map((e) => e.type)).toEqual(['RUN_STARTED', 'RUN_PAUSED', 'RUN_RESUMED', 'SEARCH_FINISHED', 'QUEUE_READY', 'RUN_STOPPED']);
    expect((await call('POST', '/api/browser/stop', { body: {} })).body.browser).toBe('STOPPED');
  });
});
