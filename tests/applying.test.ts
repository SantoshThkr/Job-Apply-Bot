import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { firstPage, launchBrowser } from '../src/browser/browser.ts';
import { disableManualPauses } from '../src/browser/session.ts';
import { loadEnv, paths, type Answer } from '../src/config.ts';
import { applicationQueue, listApplications } from '../src/db/applications.ts';
import { openDatabase } from '../src/db/database.ts';
import { insertJob, listJobs, setJobClassification, updateJobStatus } from '../src/db/jobs.ts';
import { runEvents } from '../src/db/runs.ts';
import type { ApplySettings, BotEvent } from '../src/domain.ts';
import { events } from '../src/events.ts';
import type { ApplicantFacts } from '../src/jobs/answers.ts';
import { applyToJobs, isAnsweredBy, type ApplyContext } from '../src/jobs/applying.ts';
import { jobCities } from '../src/jobs/filtering.ts';
import { normalizeCard } from '../src/jobs/normalization.ts';
import { runApplications } from '../src/jobs/runs.ts';
import { jobUrl, serveFakeNaukri, type FakeCard, type FakeJob, type FakeNaukri } from './naukri-fake.ts';

const channel = process.env.BROWSER_CHANNEL === 'chromium' ? 'chromium' : 'chrome';
const settings: ApplySettings = {
  profiles: [],
  freshness: 'all',
  minMatchScore: 75,
  autoApply: true,
  autoFill: true,
  delaySeconds: 0,
  debugScreenshots: false,
  search: false,
  limit: null,
};
const env = loadEnv({ DELAY_MIN_MS: '0', DELAY_MAX_MS: '0' });
const answers: Answer[] = [
  { match: ['relocate'], answer: 'Yes' },
  { match: ['notice period'], answer: '30 days' },
];
// Not anyone's real details.
const facts: ApplicantFacts = { name: 'Test Candidate', experienceYears: 7, skills: ['React'], email: 'candidate@example.com', noticePeriodDays: 30 };

let context: BrowserContext;
let page: Page;
let profileDir: string;
let configDir: string;
let dataDir: string;

beforeAll(async () => {
  disableManualPauses();
  profileDir = mkdtempSync(join(tmpdir(), 'naukri-bot-apply-'));
  // The shipped job profiles, and a profile with no saved answers or resume: runs must work without them.
  configDir = mkdtempSync(join(tmpdir(), 'naukri-bot-config-'));
  copyFileSync(join(paths.config, 'job-profiles.example.json'), join(configDir, 'job-profiles.example.json'));
  dataDir = mkdtempSync(join(tmpdir(), 'naukri-bot-data-'));
  writeFileSync(
    join(dataDir, 'user-profile.json'),
    JSON.stringify({ firstName: 'Test', lastName: 'Candidate', email: 'candidate@example.com', experienceYears: 7, skills: ['React'], preferredLocations: ['Bangalore'] }),
  );
  context = await launchBrowser({ headless: true, channel, profileDir });
  page = await firstPage(context);
});

afterAll(async () => {
  await context.close();
  for (const dir of [profileDir, configDir, dataDir]) rmSync(dir, { recursive: true, force: true });
});

let db: DatabaseSync;
beforeEach(() => {
  db = openDatabase(':memory:');
});

const HOUR = 3_600_000;

// A job as a search and the AI would leave it: sorted into a profile and scored.
function addJob(id: string, score: number, company = `Company ${id}`, { hoursAgo = 1, profiles = ['react'] } = {}): number {
  const card = normalizeCard({
    externalId: id,
    url: jobUrl(id),
    title: profiles.includes('angular') ? 'Angular Developer' : 'React Developer',
    company,
    location: 'Bengaluru',
    experience: '5-9 Yrs',
    posted: Date.now() - hoursAgo * HOUR,
  })!;
  insertJob(db, card, 'test');
  const { id: jobId } = db.prepare('SELECT id FROM jobs WHERE external_id = ?').get(id) as { id: number };
  updateJobStatus(db, jobId, score >= 75 ? 'SHORTLISTED' : 'SKIPPED', { matchScore: score, filterReason: null });
  setJobClassification(db, jobId, { profiles, cities: jobCities(card) });
  return jobId;
}

const queueFor = (s: ApplySettings) => applicationQueue(db, { scope: s, minMatchScore: s.minMatchScore, isAnswered: isAnsweredBy(answers, facts) }).jobs;

function createRunRow(id = 'RUN-TEST'): string {
  db.prepare(`INSERT INTO runs (id, kind, started_at) VALUES (?, 'APPLY', '2026-09-25T10:00:00Z')`).run(id);
  return id;
}

const context_ = (overrides: Partial<ApplyContext> = {}): ApplyContext => ({
  page,
  db,
  runId: 'RUN-TEST',
  settings,
  answers,
  facts,
  resumePath: null,
  waitMs: 2_000,
  browseDelayMs: [0, 0],
  ...overrides,
});

async function applyAll(jobs: FakeJob[], overrides: Partial<ApplySettings> = {}, runId = createRunRow()): Promise<FakeNaukri> {
  const fake = await serveFakeNaukri(context, jobs);
  const merged = { ...settings, ...overrides };
  await applyToJobs(context_({ runId, settings: merged }), queueFor(merged), {});
  return fake;
}

const outcomes = (runId = 'RUN-TEST') =>
  Object.fromEntries(
    listApplications(db, { runId }).map((a) => [
      a.company,
      { status: a.status, code: a.failureCode, clicked: a.applyClicked, submitted: a.submitClicked, confirmed: a.successConfirmed },
    ]),
  );

const jobStatus = (jobId: number) => (db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string }).status;
// Every step recorded for the run's attempts, oldest first.
const steps = (runId = 'RUN-TEST') =>
  listApplications(db, { runId })
    .reverse()
    .flatMap((a) => runEvents(db, { applicationId: a.id }).map((e) => e.type));

describe('applying to Naukri jobs (fake pages)', () => {
  it('marks APPLIED only with Naukri’s confirmation, and records each step', async () => {
    const jobId = addJob('100000000001', 92, 'Acme');
    const fake = await applyAll([{ id: '100000000001', kind: 'one-click' }]);

    expect(outcomes()).toEqual({ Acme: { status: 'APPLIED', code: null, clicked: true, submitted: true, confirmed: true } });
    expect(jobStatus(jobId)).toBe('APPLIED');
    expect(fake.clicks.get('100000000001')).toBe(1);
    expect(steps()).toEqual(['JOB_STARTED', 'JOB_OPENED', 'APPLY_BUTTON_FOUND', 'APPLY_CLICKED', 'FORM_SUBMITTED', 'APPLICATION_CONFIRMED']);
  });

  it('confirms from a reload when Naukri shows nothing after the click', async () => {
    addJob('100000000001', 90, 'Quiet');
    await applyAll([{ id: '100000000001', kind: 'quiet' }]);
    expect(outcomes().Quiet).toMatchObject({ status: 'APPLIED', confirmed: true });
  });

  it('sends an unconfirmed click to review, never to APPLIED or FAILED', async () => {
    const jobId = addJob('100000000001', 90, 'Silent');
    await applyAll([{ id: '100000000001', kind: 'no-response' }]);
    expect(outcomes().Silent).toEqual({ status: 'NEEDS_REVIEW', code: 'SUBMIT_UNVERIFIED', clicked: true, submitted: true, confirmed: false });
    expect(jobStatus(jobId)).toBe('SHORTLISTED');
    // Possibly sent, so it is never clicked again automatically.
    expect(applicationQueue(db, { scope: settings, minMatchScore: 75, isAnswered: () => true }).excluded[0]?.reason).toMatch(/Possibly sent/);
  });

  it('records FAILED on Naukri’s own error message', async () => {
    addJob('100000000001', 90, 'Broken');
    await applyAll([{ id: '100000000001', kind: 'error' }]);
    expect(outcomes().Broken).toEqual({ status: 'FAILED', code: 'SUBMIT_ERROR', clicked: true, submitted: false, confirmed: false });
  });

  it('stops at READY_TO_APPLY without clicking when auto apply is off', async () => {
    addJob('100000000001', 95, 'Acme');
    const fake = await applyAll([{ id: '100000000001', kind: 'one-click' }], { autoApply: false });
    expect(outcomes().Acme).toEqual({ status: 'READY_TO_APPLY', code: 'AUTO_APPLY_OFF', clicked: false, submitted: false, confirmed: false });
    expect(fake.clicks.size).toBe(0);
    // Still in the queue for a run with auto apply on.
    expect(applicationQueue(db, { scope: settings, minMatchScore: 75, isAnswered: () => false }).jobs).toHaveLength(1);
  });

  it('answers recruiter questions only from configured answers', async () => {
    addJob('100000000001', 91, 'Beta');
    const fake = await applyAll([
      {
        id: '100000000001',
        kind: 'questions',
        questions: [{ text: 'Are you willing to relocate?', options: ['Yes', 'No'] }, { text: 'What is your notice period?' }],
      },
    ]);
    expect(outcomes().Beta).toMatchObject({ status: 'APPLIED', confirmed: true });
    expect(fake.answers.get('100000000001')).toEqual(['Yes', '30 days']);
    expect(steps()).toEqual(expect.arrayContaining(['FORM_OPENED', 'FORM_FIELD_DETECTED', 'FORM_FIELD_FILLED', 'FORM_SUBMITTED']));
  });

  it('sends an unknown required question to review without answering or submitting', async () => {
    const jobId = addJob('100000000001', 91, 'Gamma');
    const fake = await applyAll([
      {
        id: '100000000001',
        kind: 'questions',
        questions: [{ text: 'Are you willing to relocate?', options: ['Yes', 'No'] }, { text: 'Do you have authorization to work in the US?', options: ['Yes', 'No'] }],
      },
    ]);
    const [application] = listApplications(db, { runId: 'RUN-TEST' });
    expect(application).toMatchObject({
      status: 'NEEDS_REVIEW',
      failureCode: 'UNKNOWN_REQUIRED_QUESTION',
      question: 'Do you have authorization to work in the US?',
      formOpened: true,
      submitClicked: false,
    });
    expect(fake.answers.get('100000000001')).toEqual(['Yes']);
    expect(fake.applied.size).toBe(0);
    expect(jobStatus(jobId)).toBe('SHORTLISTED');

    // Left out of the next queue until an answer exists, then back in.
    const queue = (known: Answer[]) => applicationQueue(db, { scope: settings, minMatchScore: 75, isAnswered: isAnsweredBy(known) });
    expect(queue(answers).excluded[0]?.reason).toMatch(/authorization to work in the US/);
    expect(queue([...answers, { match: ['authorization', 'us'], answer: 'No' }]).jobs).toHaveLength(1);
  });

  it('fills a form from known fields, then submits and confirms: FORM_OPENED, FORM_FILLED, SUBMIT_CLICKED, APPLIED', async () => {
    addJob('100000000001', 91, 'Formly');
    const fake = await applyAll([{ id: '100000000001', kind: 'form' }]);
    expect(outcomes().Formly).toEqual({ status: 'APPLIED', code: null, clicked: true, submitted: true, confirmed: true });
    // Name and email from the applicant facts, notice period mapped to the exact option, the optional
    // field nobody configured left empty.
    expect(fake.forms.get('100000000001')).toEqual({
      name: 'Test Candidate',
      email: 'candidate@example.com',
      notice: '30',
      relocate: 'yes',
      portfolio: '',
    });
    expect(steps()).toEqual(expect.arrayContaining(['FORM_OPENED', 'FORM_FIELD_FILLED', 'FORM_FILLED', 'READY_TO_SUBMIT', 'FORM_SUBMITTED', 'APPLICATION_CONFIRMED']));
    const [attempt] = listApplications(db, { runId: 'RUN-TEST' });
    expect(attempt).toMatchObject({ formOpened: true, formFilled: true });
  });

  it('never submits a form with a required field it cannot answer', async () => {
    addJob('100000000001', 91, 'Payroll');
    const fake = await applyAll([{ id: '100000000001', kind: 'form-unknown' }]);
    expect(listApplications(db, { runId: 'RUN-TEST' })[0]).toMatchObject({
      status: 'NEEDS_REVIEW',
      failureCode: 'UNKNOWN_REQUIRED_QUESTION',
      question: 'Current CTC (in lakhs) *',
      formOpened: true,
      formFilled: false,
      submitClicked: false,
    });
    expect(fake.forms.size).toBe(0);
  });

  it('holds a filled form at READY_TO_SUBMIT when the run is stopped right before submitting', async () => {
    addJob('100000000001', 91, 'Formly');
    const fake = await serveFakeNaukri(context, [{ id: '100000000001', kind: 'form' }]);
    const abort = new AbortController();
    const stopWhenReady = (event: BotEvent) => {
      if (event.type === 'READY_TO_SUBMIT') abort.abort('Stopped from the dashboard');
    };
    events.on('event', stopWhenReady);
    try {
      await applyToJobs(context_({ runId: createRunRow(), signal: abort.signal }), queueFor(settings), {});
    } finally {
      events.off('event', stopWhenReady);
    }
    expect(outcomes().Formly).toEqual({ status: 'READY_TO_SUBMIT', code: 'RUN_STOPPED', clicked: true, submitted: false, confirmed: false });
    expect(fake.forms.size).toBe(0);
  });

  it('records external, already applied and missing-button jobs, and keeps going after a failure', async () => {
    const applied = addJob('100000000002', 89, 'Applied Co');
    addJob('100000000001', 90, 'External Co');
    addJob('100000000003', 88, 'Expired Co');
    addJob('100000000004', 87, 'Down Co');
    addJob('100000000005', 86, 'Last Co');
    const fake = await applyAll([
      { id: '100000000001', kind: 'external' },
      { id: '100000000002', kind: 'applied' },
      { id: '100000000003', kind: 'expired' },
      { id: '100000000004', kind: 'unreachable' },
      { id: '100000000005', kind: 'one-click' },
    ]);

    expect(outcomes()).toMatchObject({
      'External Co': { status: 'EXTERNAL', code: 'EXTERNAL_APPLICATION', clicked: false },
      'Applied Co': { status: 'ALREADY_APPLIED', code: 'ALREADY_APPLIED', clicked: false },
      'Expired Co': { status: 'FAILED', code: 'JOB_UNAVAILABLE' },
      'Down Co': { status: 'FAILED', code: 'PAGE_ERROR', clicked: false },
      'Last Co': { status: 'APPLIED' },
    });
    const external = listApplications(db, { runId: 'RUN-TEST' }).find((a) => a.company === 'External Co');
    expect(external?.externalUrl).toBe('https://careers.example.com/jobs/42');
    expect(external?.failureReason).toMatch(/careers\.example\.com/);
    expect(jobStatus(applied)).toBe('APPLIED');
    expect(fake.clicks.size).toBe(1);
  });

  it('finds Naukri\'s Apply and company-site buttons by name when the ids are missing, and never clicks Save', async () => {
    addJob('100000000001', 92, 'Named Co');
    addJob('100000000002', 91, 'Named Site Co');
    const fake = await applyAll([
      { id: '100000000001', kind: 'named-buttons' },
      { id: '100000000002', kind: 'named-external' },
    ]);
    expect(outcomes()).toMatchObject({
      'Named Co': { status: 'APPLIED', clicked: true, confirmed: true },
      'Named Site Co': { status: 'EXTERNAL', clicked: false },
    });
    expect([...fake.clicks.keys()]).toEqual(['100000000001']);
    expect(fake.saves.size).toBe(0);
  });

  it('confirms when Naukri turns the Apply button into Applied, and records the calls it made', async () => {
    addJob('100000000001', 92, 'Flip Co');
    await applyAll([{ id: '100000000001', kind: 'in-place' }]);
    expect(outcomes()['Flip Co']).toEqual({ status: 'APPLIED', code: null, clicked: true, submitted: true, confirmed: true });
  });

  it('sends a question chat it cannot read to review, without calling it sent', async () => {
    addJob('100000000001', 92, 'Chat Co');
    addJob('100000000002', 91, 'Next Co');
    const fake = await applyAll([
      { id: '100000000001', kind: 'chat-unknown-markup' },
      { id: '100000000002', kind: 'one-click' },
    ]);
    expect(outcomes()).toMatchObject({
      'Chat Co': { status: 'NEEDS_REVIEW', code: 'UNSUPPORTED_FIELD', clicked: true, submitted: false, confirmed: false },
      // The run carries on to the next job by itself.
      'Next Co': { status: 'APPLIED' },
    });
    const chat = listApplications(db, { runId: 'RUN-TEST' }).find((a) => a.company === 'Chat Co')!;
    expect(chat.formOpened).toBe(true);
    const clicked = runEvents(db, { applicationId: chat.id }).find((e) => e.type === 'APPLY_CLICKED');
    expect(clicked?.detail).toEqual({ naukriResponse: 'QUESTIONS_UNREADABLE', naukriCalls: ['chatbot 200'] });
    // Not possibly sent, so it is not counted as an unconfirmed submission either.
    expect(queueFor(settings).map((job) => job.company)).toEqual([]);
    expect(fake.clicks.size).toBe(2);
  }, 60_000);

  it('confirms from Naukri\'s reply to the apply call, in its own words', async () => {
    addJob('100000000001', 92, 'Api Co');
    await applyAll([{ id: '100000000001', kind: 'api-success' }]);
    expect(outcomes()['Api Co']).toEqual({ status: 'APPLIED', code: null, clicked: true, submitted: true, confirmed: true });
    const events = runEvents(db, { applicationId: listApplications(db, { runId: 'RUN-TEST' })[0]!.id });
    expect(events.find((e) => e.type === 'APPLICATION_CONFIRMED')?.message).toBe('Application confirmed: Naukri: "You have successfully applied to this job."');
    expect(events.find((e) => e.type === 'APPLY_CLICKED')?.detail).toEqual({ naukriResponse: 'CONFIRMED', naukriCalls: ['apply 200'] });
  });

  it('leaves jobs the search already knows are external out of the queue', () => {
    const jobId = addJob('100000000001', 95, 'Site Co');
    db.prepare('UPDATE jobs SET external_apply = 1 WHERE id = ?').run(jobId);
    const queue = applicationQueue(db, { scope: settings, minMatchScore: 75, isAnswered: () => false });
    expect(queue.jobs).toEqual([]);
    expect(queue.excluded[0]?.reason).toMatch(/company's site/);
  });

  it('never attempts a job twice: applied jobs leave the queue and the database check catches races', async () => {
    const jobId = addJob('100000000001', 92, 'Acme');
    await applyAll([{ id: '100000000001', kind: 'one-click' }]);
    const queue = applicationQueue(db, { scope: settings, minMatchScore: 75, isAnswered: () => false });
    expect(queue.jobs).toEqual([]);
    expect(queue.excluded[0]).toMatchObject({ jobId, reason: 'Already applied' });

    // Another run applies to a second job after this run has queued it but before it gets there.
    const raced = addJob('100000000002', 91, 'Raced');
    createRunRow('RUN-OTHER');
    const otherRunApplies = (event: BotEvent) => {
      if (event.type !== 'JOB_STARTED' || event.jobId !== raced) return;
      db.prepare(
        `INSERT INTO applications (run_id, job_id, status, apply_button_found, apply_clicked, submit_clicked, success_confirmed, started_at, completed_at)
         VALUES ('RUN-OTHER', ?, 'APPLIED', 1, 1, 1, 1, ?, ?)`,
      ).run(raced, new Date().toISOString(), new Date().toISOString());
    };
    const fake = await serveFakeNaukri(context, [{ id: '100000000002', kind: 'one-click' }]);
    const queued = queueFor(settings);
    events.on('event', otherRunApplies);
    try {
      await applyToJobs(context_({ runId: createRunRow('RUN-TEST-2') }), queued, {});
    } finally {
      events.off('event', otherRunApplies);
    }
    expect(outcomes('RUN-TEST-2').Raced).toMatchObject({ status: 'ALREADY_APPLIED', code: 'ALREADY_APPLIED', clicked: false });
    expect(fake.clicks.size).toBe(0);
  });

  it('queues the freshest jobs first, within the chosen profiles and freshness', () => {
    addJob('100000000001', 95, 'Old', { hoursAgo: 60 });
    addJob('100000000002', 80, 'Newest', { hoursAgo: 1 });
    addJob('100000000003', 90, 'Angular Co', { hoursAgo: 2, profiles: ['angular'] });
    addJob('100000000004', 74, 'Low score', { hoursAgo: 1 });
    const queue = (scope: Partial<ApplySettings>) =>
      applicationQueue(db, { scope: { ...settings, ...scope }, minMatchScore: 75, isAnswered: () => false }).jobs.map((j) => j.company);
    expect(queue({})).toEqual(['Newest', 'Angular Co', 'Old']);
    expect(queue({ profiles: ['react'] })).toEqual(['Newest', 'Old']);
    expect(queue({ freshness: '24h' })).toEqual(['Newest', 'Angular Co']);
    expect(queue({ profiles: ['angular', 'react'], freshness: '3d' })).toEqual(['Newest', 'Angular Co', 'Old']);
  });

  it('works through a large queue with no cap on how many jobs it takes', async () => {
    const fakeJobs: FakeJob[] = [];
    for (let i = 0; i < 1_200; i++) addJob(String(300000000000 + i), 80 + (i % 20), `Company ${i}`, { hoursAgo: i % 90 });
    expect(applicationQueue(db, { scope: settings, minMatchScore: 75, isAnswered: () => false }).jobs).toHaveLength(1_200);

    // 150 of them through the browser, with auto apply off so each is a quick look.
    db.exec(`UPDATE jobs SET match_score = 10 WHERE id > 150`);
    for (let i = 0; i < 150; i++) fakeJobs.push({ id: String(300000000000 + i), kind: 'one-click' });
    const fake = await serveFakeNaukri(context, fakeJobs);
    const stats: Record<string, number> = {};
    const checkOnly = { ...settings, autoApply: false };
    const queue = queueFor(checkOnly);
    expect(queue).toHaveLength(150);
    await applyToJobs(context_({ runId: createRunRow(), settings: checkOnly }), queue, stats);
    expect(stats).toMatchObject({ processed: 150 });
    const results = listApplications(db, { runId: 'RUN-TEST' });
    expect(results).toHaveLength(150);
    expect(results.every((a) => a.status === 'READY_TO_APPLY')).toBe(true);
    expect(fake.clicks.size).toBe(0);
  }, 180_000);
});

describe('application runs', () => {
  const options = () => ({ dirs: { config: configDir, data: dataDir }, waitMs: 2_000, browseDelayMs: [0, 0] as [number, number] });

  it('stops the whole run on a security check and records it against the job', async () => {
    addJob('100000000001', 95, 'First', { hoursAgo: 1 });
    addJob('100000000002', 90, 'Blocked', { hoursAgo: 2 });
    addJob('100000000003', 85, 'Never', { hoursAgo: 3 });
    await serveFakeNaukri(context, [
      { id: '100000000001', kind: 'one-click' },
      { id: '100000000002', kind: 'challenge' },
      { id: '100000000003', kind: 'one-click' },
    ]);
    const run = await runApplications(page, db, env, settings, options()).done;

    expect(run).toMatchObject({ status: 'STOPPED', stopCode: 'SECURITY_CHALLENGE', attempted: 2 });
    expect(run.outcomes).toMatchObject({ applied: 1, failed: 1 });
    expect(outcomes(run.id)).toMatchObject({ First: { status: 'APPLIED' }, Blocked: { status: 'SECURITY_CHALLENGE', code: 'SECURITY_CHALLENGE' } });
    expect(outcomes(run.id).Never).toBeUndefined();
  });

  it('stops the run once Naukri\'s daily limit is used up, and when Naukri refuses for it', async () => {
    addJob('100000000001', 95, 'Last Of Today', { hoursAgo: 1 });
    addJob('100000000002', 90, 'Tomorrow', { hoursAgo: 2 });
    const fake = await serveFakeNaukri(
      context,
      [
        { id: '100000000001', kind: 'api-success' },
        { id: '100000000002', kind: 'api-success' },
      ],
      { dailyApplied: 49, dailyQuota: 50 },
    );
    const run = await runApplications(page, db, env, settings, options()).done;
    expect(run).toMatchObject({ status: 'STOPPED', stopCode: 'DAILY_LIMIT', attempted: 1, outcomes: { applied: 1 } });
    expect(run.stopReason).toMatch(/daily limit of 50 applications is reached/);
    expect(fake.clicks.get('100000000002')).toBeUndefined();

    // Refused outright: the job fails with Naukri's words, and the run stops rather than try the rest.
    addJob('100000000003', 88, 'Refused', { hoursAgo: 1 });
    await serveFakeNaukri(context, [
      { id: '100000000003', kind: 'api-limit' },
      { id: '100000000002', kind: 'api-success' },
    ]);
    const refused = await runApplications(page, db, env, settings, options()).done;
    expect(refused).toMatchObject({ status: 'STOPPED', stopCode: 'DAILY_LIMIT', attempted: 1, outcomes: { failed: 1 } });
    expect(outcomes(refused.id).Refused).toMatchObject({ status: 'FAILED', code: 'SUBMIT_ERROR' });
  });

  it('refuses to start when the Naukri session is gone', async () => {
    addJob('100000000001', 95);
    const fake = await serveFakeNaukri(context, [{ id: '100000000001', kind: 'one-click' }], { loggedIn: false });
    const run = await runApplications(page, db, env, settings, options()).done;
    expect(run).toMatchObject({ status: 'STOPPED', stopCode: 'SESSION_EXPIRED', attempted: 0 });
    expect(fake.clicks.size).toBe(0);
  });

  it('pauses between jobs and carries on when resumed', async () => {
    addJob('100000000001', 95, 'First', { hoursAgo: 1 });
    addJob('100000000002', 90, 'Second', { hoursAgo: 2 });
    await serveFakeNaukri(context, [
      { id: '100000000001', kind: 'one-click' },
      { id: '100000000002', kind: 'one-click' },
    ]);
    let resume = () => {};
    let paused: Promise<void> | null = null;
    const pauseAfterFirst = (event: BotEvent) => {
      if (event.type === 'APPLICATION_CONFIRMED' && event.company === 'First') paused = new Promise((done) => (resume = done));
    };
    events.on('event', pauseAfterFirst);
    try {
      const done = runApplications(page, db, env, settings, { ...options(), whilePaused: () => paused ?? Promise.resolve() }).done;
      await new Promise((wait) => setTimeout(wait, 3_000));
      expect(listApplications(db).map((a) => a.company)).toEqual(['First']);
      paused = null;
      resume();
      const run = await done;
      expect(run).toMatchObject({ status: 'COMPLETED', attempted: 2 });
      expect(run.outcomes.applied).toBe(2);
    } finally {
      events.off('event', pauseAfterFirst);
    }
  });

  it('stops gracefully between jobs without submitting anything because of the stop', async () => {
    addJob('100000000001', 95, 'First', { hoursAgo: 1 });
    addJob('100000000002', 90, 'Second', { hoursAgo: 2 });
    const fake = await serveFakeNaukri(context, [
      { id: '100000000001', kind: 'one-click' },
      { id: '100000000002', kind: 'one-click' },
    ]);
    const abort = new AbortController();
    const stopAfterFirst = (event: BotEvent) => {
      if (event.type === 'APPLICATION_CONFIRMED') abort.abort('Stopped from the dashboard');
    };
    events.on('event', stopAfterFirst);
    try {
      const run = await runApplications(page, db, env, { ...settings, delaySeconds: 30 }, { ...options(), signal: abort.signal }).done;
      expect(run).toMatchObject({ status: 'STOPPED', stopReason: 'Stopped from the dashboard', stopCode: null, attempted: 1 });
      expect(fake.clicks.get('100000000002')).toBeUndefined();
      const types = runEvents(db, { runId: run.id }).map((e) => e.type);
      expect(types).toEqual(['RUN_STARTED', 'QUEUE_READY', 'RUN_STOPPED']);
    } finally {
      events.off('event', stopAfterFirst);
    }
  });

  it('completes and publishes events as it goes', async () => {
    addJob('100000000001', 95, 'Acme');
    await serveFakeNaukri(context, [{ id: '100000000001', kind: 'one-click' }]);
    const seen: string[] = [];
    const listen = (event: BotEvent) => seen.push(event.type);
    events.on('event', listen);
    try {
      const run = await runApplications(page, db, env, settings, options()).done;
      expect(run).toMatchObject({ status: 'COMPLETED', stats: { relevant: 1, eligible: 1, queued: 1, processed: 1 }, attempted: 1 });
      expect(seen[0]).toBe('RUN_STARTED');
      expect(seen).toContain('APPLICATION_CONFIRMED');
      expect(seen.at(-1)).toBe('RUN_COMPLETED');
    } finally {
      events.off('event', listen);
    }
  });

  it('searches Naukri, sorts what it finds, and applies to every eligible job on its own', async () => {
    const cards: FakeCard[] = [
      { id: '200000000001', title: 'React Developer', company: 'Acme', experience: '5-9 Yrs', location: 'Bengaluru' },
      { id: '200000000002', title: 'Senior React Developer', company: 'Senior Co', experience: '10-15 Yrs', location: 'Bengaluru', hoursAgo: 2 },
      { id: '200000000003', title: 'Java Developer', company: 'Java Co', experience: '3-6 Yrs', location: 'Bengaluru', hoursAgo: 3 },
      { id: '200000000004', title: 'React Developer', company: 'Site Co', experience: '4-8 Yrs', location: 'Bengaluru', hoursAgo: 4, external: true },
      { id: '200000000005', title: 'React Developer', company: 'Old Co', experience: '4-8 Yrs', location: 'Bengaluru', hoursAgo: 72 },
    ];
    const fake = await serveFakeNaukri(context, cards.map((card) => ({ id: card.id, kind: 'one-click' as const })), { search: cards });
    const seen: string[] = [];
    const listen = (event: BotEvent) => seen.push(event.type);
    events.on('event', listen);
    try {
      const auto = { ...settings, search: true, profiles: ['react'], locations: ['Bangalore'], freshness: '24h' as const, experienceYears: 7, toleranceMonths: 6 };
      const run = await runApplications(page, db, env, auto, options()).done;

      expect(run).toMatchObject({
        status: 'COMPLETED',
        stats: { found: 5, new: 5, relevant: 3, eligible: 2, notEligible: 1, external: 1, queued: 1, processed: 1 },
        outcomes: { applied: 1 },
      });
      // Only the eligible job on Naukri itself was clicked; the too-senior, unrelated, external and old ones weren't.
      expect([...fake.clicks.keys()]).toEqual(['200000000001']);
      expect(seen.indexOf('SEARCH_FINISHED')).toBeLessThan(seen.indexOf('QUEUE_READY'));
      expect(seen.indexOf('QUEUE_READY')).toBeLessThan(seen.indexOf('JOB_STARTED'));

      const listed = listJobs(db, { scope: auto }).jobs.map((job) => [job.company, job.category, job.ineligibleReason]);
      expect(listed).toEqual([
        ['Acme', 'applied', null],
        ['Senior Co', 'not_eligible', 'Requires 10+ years'],
        ['Site Co', 'external', null],
      ]);
    } finally {
      events.off('event', listen);
    }
  });
});
