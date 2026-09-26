import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applicationSummary,
  canTransitionApplication,
  dashboardCounts,
  listApplications,
  runOutcomes,
  startApplication,
  updateApplication,
} from '../src/db/applications.ts';
import { MIGRATIONS, openDatabase } from '../src/db/database.ts';
import { getJobDetail, insertJob, listJobs, setJobProfiles, updateJobStatus } from '../src/db/jobs.ts';
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

function addJob(
  id: string,
  { title = 'AI Engineer', company = `Company ${id}`, status = 'SHORTLISTED', score = 80, hoursAgo = 1, profiles = ['react'] } = {},
): number {
  const externalId = id.padStart(12, '1');
  const card = normalizeCard({
    externalId,
    url: `https://www.naukri.com/job-listings-x-${externalId}`,
    title,
    company,
    location: 'Pune',
    experience: '5-9 Yrs',
    posted: Date.now() - hoursAgo * HOUR,
  });
  insertJob(db, card!, 'test');
  const { id: jobId } = db.prepare('SELECT id FROM jobs WHERE external_id = ?').get(externalId) as { id: number };
  if (status !== 'DISCOVERED') {
    updateJobStatus(db, jobId, status as 'SHORTLISTED', { matchScore: status === 'SKIPPED' ? null : score, filterReason: null });
  }
  setJobProfiles(db, jobId, profiles);
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
    addJob('6', { status: 'DISCOVERED' });
    db.prepare('UPDATE jobs SET external_apply = 1 WHERE id = ?').run(addJob('7'));
    // Applied outside the bot: Naukri showed "Applied" on a job it never attempted.
    db.prepare(`UPDATE jobs SET status = 'APPLIED' WHERE id = ?`).run(addJob('8'));

    const summary = (scope: JobScope) => applicationSummary(db, { scope, minMatchScore: 75, isAnswered: () => false });
    expect(summary(ALL)).toEqual({
      counts: { ready: 2, applying: 0, applied: 1, failed: 1, external: 1, review: 1, already_applied: 1 },
      // The two ready ones plus the failure, which is retried.
      queued: 3,
      awaitingMatch: 1,
    });
    expect(summary({ profiles: ['angular'], freshness: 'all' }).counts).toMatchObject({ review: 1, ready: 0 });
    expect(summary({ profiles: [], freshness: '24h' }).counts.ready).toBe(1);
    // Like the Apply page: the job applied outside the bot is not counted as Applied.
    expect(dashboardCounts(db)).toEqual({ jobsFound: 8, freshJobs: 7, applied: 1, failed: 1 });
  });

  it('lists jobs still to act on first, freshest first, within the scope', () => {
    const run = createRun(db, 'APPLY', {});
    const applied = addJob('1', { company: 'Applied Yesterday', hoursAgo: 20 });
    attempt(run, applied, 'APPLY_CLICKED', 'SUBMIT_CLICKED', 'APPLIED');
    db.prepare(`UPDATE jobs SET status = 'APPLIED' WHERE id = ?`).run(applied);
    addJob('2', { company: 'Ready Old', hoursAgo: 50 });
    addJob('3', { company: 'Ready New', hoursAgo: 2 });
    addJob('4', { company: 'Not Matched Yet', status: 'DISCOVERED', hoursAgo: 1 });
    addJob('5', { company: 'Angular Ready', hoursAgo: 3, profiles: ['angular'] });
    addJob('6', { company: 'Low Match', status: 'REVIEW', hoursAgo: 1 });

    const companies = (options: Parameters<typeof listJobs>[1]) => listJobs(db, options).jobs.map((j) => j.company);
    expect(companies({})).toEqual(['Ready New', 'Angular Ready', 'Ready Old', 'Not Matched Yet', 'Low Match', 'Applied Yesterday']);
    expect(companies({ scope: { profiles: ['react'], freshness: '24h' } })).toEqual(['Ready New', 'Not Matched Yet', 'Low Match', 'Applied Yesterday']);
    expect(companies({ category: 'applied' })).toEqual(['Applied Yesterday']);
    expect(companies({ category: 'new' })).toEqual(['Not Matched Yet']);
    expect(listJobs(db, { limit: 2 })).toMatchObject({ total: 6, jobs: [{ company: 'Ready New', category: 'ready', profiles: ['react'] }, {}] });
  });

  it('returns a job with its details', () => {
    const jobId = addJob('1');
    expect(getJobDetail(db, jobId)).toMatchObject({ id: jobId, category: 'ready', analysis: null, externalUrl: null, profiles: ['react'] });
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
