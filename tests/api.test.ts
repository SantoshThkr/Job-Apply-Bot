import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
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
import { insertJob, updateJobStatus } from '../src/db/jobs.ts';
import type { ApplicationSummary, BotEvent, RunDetail } from '../src/domain.ts';
import { normalizeCard } from '../src/jobs/normalization.ts';
import { jobUrl, serveFakeNaukri, type FakeJob } from './naukri-fake.ts';

const channel = process.env.BROWSER_CHANNEL === 'chromium' ? 'chromium' : 'chrome';
const start = { profiles: [], freshness: 'all', autoApply: true };

let db: DatabaseSync;
let control: BotControl;
let server: Server;
let port: number;
let fakeJobs: FakeJob[] = [];
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
  control = new BotControl({
    db,
    // A long wait after each Apply click gives the stop test a fixed moment to stop in.
    env: loadEnv({ HEADLESS: 'true', APPLY_DELAY_MS: '20000', DELAY_MIN_MS: '0', DELAY_MAX_MS: '0' }),
    configDir,
    waitMs: 2_000,
    launch: async () => {
      const context: BrowserContext = await launchBrowser({ headless: true, channel, profileDir: tempDir('naukri-bot-api-') });
      await serveFakeNaukri(context, () => fakeJobs);
      return context;
    },
  });
  server = createApi({ control, db, env: loadEnv({}), configDir });
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

function addJob(id: string, score: number, company: string) {
  insertJob(db, normalizeCard({ externalId: id, url: jobUrl(id), title: 'Test Role', company, location: 'Pune', experience: '5-9 Yrs' })!, 'test');
  const { id: jobId } = db.prepare('SELECT id FROM jobs WHERE external_id = ?').get(id) as { id: number };
  updateJobStatus(db, jobId, 'SHORTLISTED', { matchScore: score, filterReason: null });
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
  it('reports status, profiles and the apply summary without secrets', async () => {
    const status = await call('GET', '/api/status');
    expect(status.body).toMatchObject({
      state: { session: 'UNKNOWN', browser: 'STOPPED', activity: null, activeRun: null },
      ai: { provider: 'Ollama', model: 'qwen3:4b' },
      counts: { jobsFound: 0, freshJobs: 0, applied: 0, failed: 0 },
    });
    const profiles = (await call('GET', '/api/profiles')).body;
    expect(profiles.map((p: { name: string }) => p.name)).toContain('Frontend Developer');
    const summary: ApplicationSummary = (await call('GET', '/api/applications/summary?profiles=react&freshness=24h')).body;
    expect(summary).toMatchObject({ queued: 0, awaitingMatch: 0, minMatchScore: 75, autoApply: false });
    expect(summary.problems.join('\n')).toMatch(/profile\.json not found/);
    expect(JSON.stringify([status.body, summary])).not.toMatch(/OPENAI_API_KEY|apiKey/);
  });

  it('validates input', async () => {
    expect((await call('GET', '/api/jobs?status=bogus')).status).toBe(400);
    expect((await call('GET', '/api/jobs?freshness=yesterday')).status).toBe(400);
    expect((await call('POST', '/api/applications/start', { body: { ...start, maxApplications: 20 } })).status).toBe(400);
    expect((await call('POST', '/api/applications/start', { body: { profiles: [], freshness: 'all' } })).status).toBe(400);
    expect((await call('GET', '/api/runs/RUN-20990101-000000')).status).toBe(404);
    expect((await call('POST', '/api/runs/stop', { body: {} })).status).toBe(409);
    expect((await call('POST', '/api/runs/pause', { body: {} })).status).toBe(409);
  });

  it('runs one application run at a time and streams it live', async () => {
    fakeJobs = [
      { id: '200000000001', kind: 'one-click' },
      { id: '200000000002', kind: 'external' },
    ];
    // The external job comes first, so the run never has to wait out the delay after Acme's click.
    addJob('200000000001', 88, 'Acme');
    addJob('200000000002', 92, 'Beta');
    expect((await call('GET', '/api/applications/summary')).body).toMatchObject({ queued: 2, counts: { ready: 2 } });

    const stream = listen((events) => events.some((e) => e.type === 'RUN_COMPLETED'));
    const started = await call('POST', '/api/applications/start', { body: start });
    expect(started.status).toBe(202);
    const second = await call('POST', '/api/applications/start', { body: start });
    expect(second).toMatchObject({ status: 409, body: { error: expect.stringMatching(/already active/) } });

    const received = await stream.done;
    await control.idle();
    expect(received[0]).toMatchObject({ type: 'STATE' });
    const types = received.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['RUN_STARTED', 'JOB_STARTED', 'APPLY_CLICKED', 'APPLICATION_CONFIRMED', 'EXTERNAL_APPLICATION', 'LOG']));

    const run: RunDetail = (await call('GET', `/api/runs/${started.body.runId}`)).body;
    expect(run).toMatchObject({ status: 'COMPLETED', attempted: 2, outcomes: { applied: 1, external: 1 } });
    expect(run.applications.map((a) => [a.company, a.status])).toEqual([
      ['Acme', 'APPLIED'],
      ['Beta', 'EXTERNAL'],
    ]);
    const detail = (await call('GET', `/api/applications/${run.applications[0]!.id}`)).body;
    expect(detail.events.map((e: { type: string }) => e.type)).toContain('APPLICATION_CONFIRMED');

    const state = (await call('GET', '/api/status')).body.state;
    expect(state).toMatchObject({ session: 'LOGGED_IN', browser: 'RUNNING', activity: null, activeRun: null });
    const applied = (await call('GET', '/api/jobs?status=applied')).body;
    expect(applied.jobs.map((j: { company: string }) => j.company)).toEqual(['Acme']);
  });

  it('pauses, resumes and stops a run, and refuses to close the browser meanwhile', async () => {
    fakeJobs = [
      { id: '200000000003', kind: 'one-click' },
      { id: '200000000004', kind: 'one-click' },
    ];
    addJob('200000000003', 91, 'Gamma');
    addJob('200000000004', 90, 'Delta');
    const { body } = await call('POST', '/api/applications/start', { body: start });
    // Paused before the first job: nothing is opened or clicked while it waits.
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
    expect(run.events.map((e) => e.type)).toEqual(['RUN_STARTED', 'RUN_PAUSED', 'RUN_RESUMED', 'RUN_STOPPED']);
    expect((await call('POST', '/api/browser/stop', { body: {} })).body.browser).toBe('STOPPED');
  });
});
