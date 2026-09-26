import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applicationQueue,
  canTransitionApplication,
  listApplications,
  runOutcomes,
  scopeSummary,
  startApplication,
  updateApplication,
} from '../src/db/applications.ts';
import { MIGRATIONS, openDatabase } from '../src/db/database.ts';
import { getJobDetail, insertJob, listJobs, setJobClassification, updateJobStatus } from '../src/db/jobs.ts';
import { jobCities } from '../src/jobs/filtering.ts';
import { closeAbandonedRuns, createRun, finishRun, getRun, listRuns, setRunPaused } from '../src/db/runs.ts';
import { APPLICATION_STATUSES, OUTCOMES, type ApplicationStatus, type JobScope } from '../src/domain.ts';
import { normalizeCard } from '../src/jobs/normalization.ts';

let db: DatabaseSync;
beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
});

const HOUR = 3_600_000;
const ALL: JobScope = { profiles: [], freshness: 'all' };

// A job as a search stores it and sorting files it: in the "react" profile, in Pune, scored 80 by
// the AI unless `status` is DISCOVERED.
function addJob(
  id: string,
  {
    title = 'AI Engineer',
    company = `Company ${id}`,
    status = 'SHORTLISTED',
    score = 80,
    hoursAgo = 1,
    profiles = ['react'],
    location = 'Pune',
    experience = '5-9 Yrs',
  } = {},
): number {
  const externalId = id.padStart(12, '0');
  const card = normalizeCard({
    externalId,
    url: `https://www.naukri.com/job-listings-x-${externalId}`,
    title,
    company,
    location,
    experience,
    posted: Date.now() - hoursAgo * HOUR,
  })!;
  insertJob(db, card, 'test');
  const { id: jobId } = db.prepare('SELECT id FROM jobs WHERE external_id = ?').get(externalId) as { id: number };
  if (status !== 'DISCOVERED') updateJobStatus(db, jobId, status as 'SHORTLISTED', { matchScore: score, filterReason: null });
  setJobClassification(db, jobId, { profiles, cities: jobCities(card) });
  return jobId;
}

// Walks an attempt through `steps`, setting the flags each step implies.
function attempt(run: string, jobId: number, ...steps: ApplicationStatus[]) {
  const id = startApplication(db, run, { jobId, score: 80 });
  for (const status of steps) {
    updateApplication(db, id, {
      status,
      applyClicked: status === 'APPLY_CLICKED' || undefined,
      formOpened: status === 'FORM_OPENED' || undefined,
      submitClicked: status === 'SUBMIT_CLICKED' || undefined,
      successConfirmed: status === 'APPLIED' || undefined,
    });
  }
  return id;
}

describe('application state transitions', () => {
  it('reaches APPLIED only through a submit, and never leaves a final status', () => {
    expect(canTransitionApplication('APPLYING', 'APPLY_CLICKED')).toBe(true);
    expect(canTransitionApplication('APPLY_CLICKED', 'SUBMIT_CLICKED')).toBe(true);
    expect(canTransitionApplication('SUBMIT_CLICKED', 'APPLIED')).toBe(true);
    for (const from of APPLICATION_STATUSES.filter((s) => s !== 'SUBMIT_CLICKED' && s !== 'APPLIED')) {
      expect(canTransitionApplication(from, 'APPLIED')).toBe(false);
    }
    for (const final of APPLICATION_STATUSES.filter((s) => OUTCOMES[s] !== 'applying')) {
      for (const to of APPLICATION_STATUSES.filter((s) => s !== final)) expect(canTransitionApplication(final, to)).toBe(false);
    }
  });

  it('keeps each stage separate: ready to apply before a click, ready to submit only with a filled form', () => {
    expect(canTransitionApplication('APPLYING', 'READY_TO_APPLY')).toBe(true);
    expect(canTransitionApplication('APPLY_CLICKED', 'READY_TO_APPLY')).toBe(false);
    expect(canTransitionApplication('FORM_OPENED', 'FORM_FILLED')).toBe(true);
    expect(canTransitionApplication('FORM_FILLED', 'READY_TO_SUBMIT')).toBe(true);
    expect(canTransitionApplication('FORM_OPENED', 'READY_TO_SUBMIT')).toBe(false);
    expect(canTransitionApplication('APPLYING', 'READY_TO_SUBMIT')).toBe(false);
  });

  it('refuses APPLIED without a confirmed success and timestamps the end', () => {
    const run = createRun(db, 'APPLY', {});
    const id = startApplication(db, run, { jobId: addJob('1'), score: 80 });
    updateApplication(db, id, { status: 'APPLY_CLICKED', applyButtonFound: true, applyClicked: true });
    updateApplication(db, id, { status: 'SUBMIT_CLICKED', submitClicked: true });
    expect(() => updateApplication(db, id, { status: 'APPLIED' })).toThrow(/without a confirmed success/);

    const done = updateApplication(db, id, { status: 'APPLIED', successConfirmed: true });
    expect(done).toMatchObject({ status: 'APPLIED', outcome: 'applied', applyClicked: true, submitClicked: true, successConfirmed: true });
    expect(done.completedAt).not.toBeNull();
    expect(() => updateApplication(db, id, { status: 'FAILED' })).toThrow(/cannot move from APPLIED to FAILED/);
  });

  it('allows one attempt per job per run', () => {
    const run = createRun(db, 'APPLY', {});
    const jobId = addJob('1');
    startApplication(db, run, { jobId, score: 80 });
    expect(() => startApplication(db, run, { jobId, score: 80 })).toThrow(/UNIQUE/);
  });
});

describe('runs', () => {
  it('creates readable run IDs, unique within the same second', () => {
    const at = new Date(2026, 8, 25, 23, 36, 12);
    expect(createRun(db, 'SEARCH', {}, at)).toBe('RUN-20260925-233612');
    expect(createRun(db, 'APPLY', {}, at)).toBe('RUN-20260925-233612-2');
  });

  it('records how a run ended, pauses and resumes, and lists newest first', () => {
    const first = createRun(db, 'SEARCH', { freshness: '24h' }, new Date(2026, 8, 24));
    const second = createRun(db, 'APPLY', { autoApply: false }, new Date(2026, 8, 25));
    finishRun(db, first, 'COMPLETED', { stats: { seen: 40, added: 12 } });
    setRunPaused(db, second, true);
    expect(getRun(db, second)?.status).toBe('PAUSED');
    setRunPaused(db, second, false);
    finishRun(db, second, 'STOPPED', { stats: { queued: 3 }, stopReason: 'Naukri logged this browser out.', stopCode: 'SESSION_EXPIRED' });

    expect(listRuns(db).map((r) => r.id)).toEqual([second, first]);
    expect(getRun(db, first)).toMatchObject({ kind: 'SEARCH', status: 'COMPLETED', settings: { freshness: '24h' }, stats: { seen: 40, added: 12 } });
    expect(getRun(db, second)).toMatchObject({ status: 'STOPPED', stopCode: 'SESSION_EXPIRED', attempted: 0 });
    expect(listRuns(db, { kind: 'APPLY' }).map((r) => r.id)).toEqual([second]);
  });

  it('closes runs whose process died, without claiming anything was applied', () => {
    const run = createRun(db, 'APPLY', {});
    db.prepare(`UPDATE runs SET pid = 999999999, status = 'PAUSED' WHERE id = ?`).run(run);
    attempt(run, addJob('1'), 'APPLY_CLICKED');
    attempt(run, addJob('2'));

    expect(closeAbandonedRuns(db)).toEqual([run]);
    expect(getRun(db, run)).toMatchObject({ status: 'FAILED', attempted: 2, outcomes: { review: 1, failed: 1, applied: 0 } });

    const mine = createRun(db, 'APPLY', {});
    expect(closeAbandonedRuns(db)).toEqual([]);
    expect(getRun(db, mine)?.status).toBe('RUNNING');
  });
});

describe('counts and job lists', () => {
  it('counts every attempt within a run', () => {
    const run = createRun(db, 'APPLY', {});
    attempt(run, addJob('1'), 'FAILED');
    attempt(run, addJob('2'), 'EXTERNAL');
    attempt(run, addJob('3'), 'READY_TO_APPLY');
    attempt(run, addJob('4'), 'APPLY_CLICKED', 'SUBMIT_CLICKED', 'APPLIED');
    expect(runOutcomes(db, run)).toEqual({
      attempted: 4,
      outcomes: { ready: 1, applying: 0, applied: 1, failed: 1, external: 1, review: 0, already_applied: 0 },
    });
  });

  it('sums up the jobs in scope by where each one stands', () => {
    const run = createRun(db, 'APPLY', {});
    attempt(run, addJob('1'), 'APPLY_CLICKED', 'SUBMIT_CLICKED', 'APPLIED');
    db.prepare(`UPDATE jobs SET status = 'APPLIED' WHERE id = 1`).run();
    attempt(run, addJob('2'), 'FAILED');
    attempt(run, addJob('3', { profiles: ['angular'] }), 'APPLY_CLICKED', 'FORM_OPENED', 'NEEDS_REVIEW');
    addJob('4');
    addJob('5', { hoursAgo: 72 });
    // Never scored by the AI: applied to all the same.
    addJob('6', { status: 'DISCOVERED' });
    db.prepare('UPDATE jobs SET external_apply = 1 WHERE id = ?').run(addJob('7'));
    // Applied outside the bot: Naukri showed "Applied" on a job it never attempted.
    db.prepare(`UPDATE jobs SET status = 'APPLIED' WHERE id = ?`).run(addJob('8'));
    addJob('9', { experience: '10-15 Yrs' });
    addJob('10', { status: 'SKIPPED', score: 52 });
    // Checked with auto apply off: still ready.
    attempt(run, addJob('11'), 'READY_TO_APPLY');
    // Relevant to no job profile: never in scope.
    addJob('12', { profiles: [] });

    const summary = (scope: JobScope) => scopeSummary(db, { scope, minMatchScore: 75, isAnswered: () => false });
    expect(summary({ ...ALL, experienceYears: 7, toleranceMonths: 6 })).toEqual({
      found: 11,
      eligible: 9,
      counts: { ready: 4, applying: 0, applied: 1, failed: 1, external: 1, review: 1, already_applied: 1, not_eligible: 2 },
      // The four ready ones plus the failure, which is retried.
      queued: 5,
    });
    // Without an experience check only the low AI match is left out.
    expect(summary(ALL)).toMatchObject({ eligible: 10, queued: 6, counts: { ready: 5, not_eligible: 1 } });
    expect(summary({ profiles: ['angular'], freshness: 'all' })).toMatchObject({ found: 1, counts: { review: 1, ready: 0 } });
    expect(summary({ profiles: [], freshness: '24h' }).counts.ready).toBe(4);
  });

  it('checks experience against the years plus the tolerance, and never hides a job for it', () => {
    for (const [id, experience] of [
      ['1', '0-2 Yrs'],
      ['2', '3-7 Yrs'],
      ['3', '7-12 Yrs'],
      ['4', '7.5-9 Yrs'],
      ['5', '8-10 Yrs'],
      ['6', '10+ Yrs'],
      ['7', ''],
    ]) {
      addJob(id!, { company: `Needs ${experience || 'nothing stated'}`, experience: experience!, status: 'DISCOVERED' });
    }
    const ready = (experienceYears: number, toleranceMonths: number) =>
      listJobs(db, { scope: { ...ALL, experienceYears, toleranceMonths } })
        .jobs.filter((job) => job.category === 'ready')
        .map((job) => job.company)
        .sort();
    expect(ready(7, 6)).toEqual(['Needs 0-2 Yrs', 'Needs 3-7 Yrs', 'Needs 7-12 Yrs', 'Needs 7.5-9 Yrs', 'Needs nothing stated']);
    expect(ready(7, 0)).toEqual(['Needs 0-2 Yrs', 'Needs 3-7 Yrs', 'Needs 7-12 Yrs', 'Needs nothing stated']);
    expect(ready(7, 12)).toContain('Needs 8-10 Yrs');

    const { jobs, total } = listJobs(db, { scope: { ...ALL, experienceYears: 7, toleranceMonths: 6 } });
    expect(total).toBe(7);
    expect(jobs.find((job) => job.company === 'Needs 10+ Yrs')).toMatchObject({ category: 'not_eligible', ineligibleReason: 'Requires 10+ years' });
    expect(jobs.find((job) => job.company === 'Needs 3-7 Yrs')).toMatchObject({ category: 'ready', ineligibleReason: null });
  });

  it('leaves out jobs the AI scored below the minimum, but not jobs it has not scored', () => {
    addJob('1', { company: 'Strong', score: 90 });
    addJob('2', { company: 'Weak', status: 'SKIPPED', score: 40 });
    addJob('3', { company: 'Unscored', status: 'DISCOVERED' });
    const { jobs } = applicationQueue(db, { scope: ALL, minMatchScore: 75, isAnswered: () => false });
    expect(jobs.map((job) => job.company).sort()).toEqual(['Strong', 'Unscored']);
    expect(listJobs(db, { minMatchScore: 75, category: 'not_eligible' }).jobs).toMatchObject([
      { company: 'Weak', ineligibleReason: 'AI match 40 is below 75' },
    ]);
  });

  it('lists jobs freshest first within the chosen profiles, locations and dates', () => {
    addJob('1', { company: 'Pune New', hoursAgo: 2 });
    addJob('2', { company: 'Pune Old', hoursAgo: 50 });
    addJob('3', { company: 'Bangalore', location: 'Bengaluru', hoursAgo: 3 });
    addJob('4', { company: 'Remote', location: 'Remote', hoursAgo: 4 });
    addJob('5', { company: 'Angular', profiles: ['angular'], hoursAgo: 1 });
    addJob('6', { company: 'Noida', location: 'Noida', hoursAgo: 5 });

    const companies = (options: Parameters<typeof listJobs>[1]) => listJobs(db, options).jobs.map((j) => j.company);
    expect(companies({})).toEqual(['Angular', 'Pune New', 'Bangalore', 'Remote', 'Noida', 'Pune Old']);
    expect(companies({ scope: { profiles: ['react'], freshness: '24h' } })).toEqual(['Pune New', 'Bangalore', 'Remote', 'Noida']);
    // Remote jobs always count; "Delhi NCR" covers Noida.
    expect(companies({ scope: { ...ALL, locations: ['Bangalore'] } })).toEqual(['Bangalore', 'Remote']);
    expect(companies({ scope: { ...ALL, locations: ['Delhi NCR'] } })).toEqual(['Remote', 'Noida']);
    const day = new Date(Date.now() - 50 * HOUR).toLocaleDateString('en-CA');
    expect(companies({ scope: { ...ALL, freshness: 'custom', from: day, to: day } })).toEqual(['Pune Old']);
    expect(listJobs(db, { limit: 2 })).toMatchObject({ total: 6, jobs: [{ company: 'Angular', category: 'ready', profiles: ['angular'] }, {}] });
  });

  it('returns a job with its details and whether it is eligible', () => {
    const jobId = addJob('1', { experience: '10-15 Yrs' });
    expect(getJobDetail(db, jobId)).toMatchObject({ id: jobId, category: 'ready', analysis: null, externalUrl: null, profiles: ['react'] });
    expect(getJobDetail(db, jobId, { scope: { ...ALL, experienceYears: 7, toleranceMonths: 6 } })).toMatchObject({
      category: 'not_eligible',
      ineligibleReason: 'Requires 10+ years',
    });
    expect(getJobDetail(db, 999)).toBeUndefined();
    expect(listApplications(db, { jobId })).toEqual([]);
  });
});

describe('migrations', () => {
  const card = (id: string) => normalizeCard({ externalId: id, url: `https://www.naukri.com/job-listings-x-${id}`, title: 'AI Engineer', company: `Co ${id}` })!;

  it('keeps every job and analysis, and backs the database up first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naukri-bot-migrate-'));
    try {
      const file = join(dir, 'jobs.db');
      // The database as Phase 3 left it.
      const old = new DatabaseSync(file);
      old.exec(`${MIGRATIONS[0]}; ${MIGRATIONS[1]}; ${MIGRATIONS[2]}; PRAGMA user_version = 3;`);
      insertJob(old, card('111122223333'), 'AI');
      old.close();

      const migrated = openDatabase(file);
      expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(migrated.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 1 });
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      migrated.close();

      const [backup] = readdirSync(join(dir, 'backups'));
      expect(backup).toMatch(/^jobs-v3-\d{8}T\d{6}\.db$/);
      const copy = new DatabaseSync(join(dir, 'backups', backup!));
      expect(copy.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
      copy.close();

      // Nothing to migrate the second time, so no second backup.
      openDatabase(file).close();
      expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('moves earlier attempts to the states that say what really happened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naukri-bot-migrate-'));
    try {
      const file = join(dir, 'jobs.db');
      // The database as the first dashboard version left it.
      const old = new DatabaseSync(file);
      old.exec(`${MIGRATIONS.slice(0, 4).join(';\n')}; PRAGMA user_version = 4;`);
      for (const id of ['111100000001', '111100000002', '111100000003', '111100000004']) insertJob(old, card(id), 'AI');
      old.exec(`INSERT INTO runs (id, kind, status, started_at) VALUES ('RUN-OLD', 'APPLY', 'COMPLETED', '2026-09-25T10:00:00Z');
        INSERT INTO applications (run_id, job_id, status, apply_button_found, apply_clicked, failure_code, failure_reason, started_at) VALUES
          ('RUN-OLD', 1, 'READY_TO_SUBMIT', 1, 0, 'AUTO_SUBMIT_OFF', 'Auto submit is off...', 'x'),
          ('RUN-OLD', 2, 'EXTERNAL_APPLICATION', 0, 0, 'EXTERNAL_APPLICATION', 'Applies on the company site', 'x'),
          ('RUN-OLD', 3, 'SUBMIT_UNVERIFIED', 1, 1, 'NO_CONFIRMATION', 'No confirmation', 'x'),
          ('RUN-OLD', 4, 'APPLY_BUTTON_NOT_FOUND', 0, 0, 'JOB_UNAVAILABLE', 'Expired', 'x');
        UPDATE jobs SET status = 'SKIPPED', filter_reason = 'Needs 13+ years; your maximum is 8' WHERE id = 4;`);
      old.close();

      const migrated = openDatabase(file);
      expect(migrated.prepare('SELECT job_id AS job, status, failure_code AS code FROM applications ORDER BY job_id').all()).toEqual([
        { job: 1, status: 'READY_TO_APPLY', code: 'AUTO_APPLY_OFF' },
        { job: 2, status: 'EXTERNAL', code: 'EXTERNAL_APPLICATION' },
        { job: 3, status: 'NEEDS_REVIEW', code: 'SUBMIT_UNVERIFIED' },
        { job: 4, status: 'FAILED', code: 'JOB_UNAVAILABLE' },
      ]);
      // Experience no longer filters anything, so what it set aside is back for matching.
      expect(migrated.prepare('SELECT status, filter_reason AS reason FROM jobs WHERE id = 4').get()).toEqual({ status: 'DISCOVERED', reason: null });
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds the city list without touching existing jobs or attempts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naukri-bot-migrate-'));
    try {
      const file = join(dir, 'jobs.db');
      const old = new DatabaseSync(file);
      old.exec(`${MIGRATIONS.slice(0, 5).join(';\n')}; PRAGMA user_version = 5;`);
      insertJob(old, card('111100000001'), 'AI');
      old.exec(`INSERT INTO runs (id, kind, status, started_at) VALUES ('RUN-OLD', 'APPLY', 'COMPLETED', '2026-09-25T10:00:00Z');
        INSERT INTO applications (run_id, job_id, status, started_at) VALUES ('RUN-OLD', 1, 'READY_TO_APPLY', 'x');`);
      old.close();

      const migrated = openDatabase(file);
      expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 });
      expect(migrated.prepare('SELECT title, cities FROM jobs').get()).toEqual({ title: 'AI Engineer', cities: '[]' });
      expect(migrated.prepare('SELECT status FROM applications').get()).toEqual({ status: 'READY_TO_APPLY' });
      expect(readdirSync(join(dir, 'backups'))[0]).toMatch(/^jobs-v5-/);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not back up a brand-new database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naukri-bot-new-'));
    try {
      openDatabase(join(dir, 'jobs.db')).close();
      expect(existsSync(join(dir, 'backups'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
