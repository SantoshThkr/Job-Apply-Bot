import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase } from '../src/db/database.ts';
import {
  JOB_STATUSES,
  canTransition,
  insertJob,
  jobCounts,
  jobsNeedingDetails,
  recordDetailFailure,
  saveJobDetails,
  updateJobStatus,
} from '../src/db/jobs.ts';
import { normalizeCard, type RawCard } from '../src/jobs/normalization.ts';

function card(overrides: RawCard = {}) {
  const job = normalizeCard({
    externalId: '111122223333',
    url: 'https://www.naukri.com/job-listings-ai-engineer-acme-bengaluru-6-to-9-years-111122223333',
    title: 'AI Engineer',
    company: 'Acme Pvt Ltd',
    location: 'Bengaluru',
    experience: '6-9 Yrs',
    skills: ['Python'],
    ...overrides,
  });
  if (!job) throw new Error('test card is invalid');
  return job;
}

describe('jobs table', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('stores a new job once', () => {
    expect(insertJob(db, card(), 'AI')).toBe(true);
    expect(insertJob(db, card(), 'AI')).toBe(false);
    expect(jobCounts(db, new Date(0))).toMatchObject({ total: 1, byStatus: { DISCOVERED: 1 } });
  });

  it('treats the same Naukri ID under another URL as a duplicate', () => {
    insertJob(db, card(), 'AI');
    expect(insertJob(db, card({ url: 'https://www.naukri.com/job-listings-renamed-111122223333', title: 'Renamed' }), 'AI')).toBe(false);
  });

  it('treats the same URL without an ID as a duplicate', () => {
    insertJob(db, card(), 'AI');
    expect(insertJob(db, card({ externalId: undefined, title: 'Different title' }), 'AI')).toBe(false);
  });

  it('treats the same company, title and location as a duplicate', () => {
    insertJob(db, card(), 'AI');
    const repost = card({
      externalId: '999988887777',
      url: 'https://www.naukri.com/job-listings-ai-engineer-acme-999988887777',
      company: 'ACME Private Limited',
      location: 'Hybrid - Bangalore',
    });
    expect(insertJob(db, repost, 'AI')).toBe(false);
  });

  it('keeps genuinely different jobs', () => {
    insertJob(db, card(), 'AI');
    const other = card({ externalId: '444455556666', url: 'https://www.naukri.com/job-listings-x-444455556666', location: 'Pune' });
    expect(insertJob(db, other, 'AI')).toBe(true);
  });

  it('queues jobs for details until read, and gives up after repeated failures', () => {
    insertJob(db, card(), 'AI');
    const second = card({ externalId: '444455556666', url: 'https://www.naukri.com/job-listings-x-444455556666', title: 'ML Engineer' });
    insertJob(db, second, 'AI');
    const [first, other] = jobsNeedingDetails(db, 10);

    saveJobDetails(db, first!.id, {
      description: 'Build RAG pipelines',
      skills: ['Python', 'RAG'],
      employmentType: 'Full Time, Permanent',
      postedAt: '2026-09-20',
      workMode: null,
    });
    for (let i = 0; i < 3; i++) recordDetailFailure(db, other!.id);

    expect(jobsNeedingDetails(db, 10)).toEqual([]);
    const stored = db.prepare('SELECT description, skills, posted_at, work_mode FROM jobs WHERE id = ?').get(first!.id);
    expect(stored).toMatchObject({
      description: 'Build RAG pipelines',
      skills: '["Python","RAG"]',
      posted_at: '2026-09-20',
      work_mode: 'Office',
    });
    expect(jobCounts(db, new Date(0)).withDetails).toBe(1);
  });
});

describe('status transitions', () => {
  it('allows the normal flow and re-analysis, and nothing after APPLIED', () => {
    expect(canTransition('DISCOVERED', 'SHORTLISTED')).toBe(true);
    expect(canTransition('SHORTLISTED', 'SKIPPED')).toBe(true);
    expect(canTransition('SKIPPED', 'DISCOVERED')).toBe(true);
    expect(canTransition('READY_TO_SUBMIT', 'APPLIED')).toBe(true);
    expect(canTransition('REVIEW', 'REVIEW')).toBe(true);
    expect(canTransition('DISCOVERED', 'ANALYSIS_FAILED')).toBe(true);
    expect(canTransition('ANALYSIS_FAILED', 'SHORTLISTED')).toBe(true);
    expect(canTransition('SHORTLISTED', 'ANALYSIS_FAILED')).toBe(false);
    expect(canTransition('DISCOVERED', 'APPLIED')).toBe(false);
    expect(canTransition('SHORTLISTED', 'READY_TO_SUBMIT')).toBe(false);
    for (const status of JOB_STATUSES.filter((s) => s !== 'APPLIED')) expect(canTransition('APPLIED', status)).toBe(false);
  });

  it('refuses an invalid move and records score and filter reason on a valid one', () => {
    const db = openDatabase(':memory:');
    insertJob(db, card(), 'AI');
    const id = jobsNeedingDetails(db, 1)[0]!.id;
    expect(() => updateJobStatus(db, id, 'APPLIED', { matchScore: null, filterReason: null })).toThrow(/cannot move from DISCOVERED to APPLIED/);
    updateJobStatus(db, id, 'SKIPPED', { matchScore: null, filterReason: 'Needs 15+ years' });
    expect(db.prepare('SELECT status, filter_reason FROM jobs WHERE id = ?').get(id)).toEqual({
      status: 'SKIPPED',
      filter_reason: 'Needs 15+ years',
    });
    db.close();
  });
});

describe('migration to ANALYSIS_FAILED', () => {
  it('rebuilds the jobs table without losing jobs or their analyses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naukri-bot-migrate-'));
    try {
      const file = join(dir, 'jobs.db');
      // A database as Phase 3 (before local AI) left it: two migrations, one job, one analysis.
      const old = new DatabaseSync(file);
      old.exec(`${MIGRATIONS[0]}; ${MIGRATIONS[1]}; PRAGMA user_version = 2;`);
      insertJob(old, card(), 'AI');
      old.exec(`INSERT INTO job_analysis (job_id, cache_key, model, prompt_version, evidence, score, recommendation,
        matched_skills, missing_skills, red_flags, reason, breakdown, analyzed_at)
        VALUES (1, 'k', 'gpt-5-mini', 'job-match.v1', '{}', 80, 'MATCH', '[]', '[]', '[]', 'r', '{}', 'now')`);
      old.close();

      const db = openDatabase(file);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
      expect(db.prepare('SELECT count(*) AS n FROM job_analysis').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT title, analysis_error FROM jobs').get()).toEqual({ title: 'AI Engineer', analysis_error: null });
      updateJobStatus(db, 1, 'ANALYSIS_FAILED', { matchScore: null, filterReason: null, analysisError: 'timed out' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('database file', () => {
  it('runs migrations once and keeps data across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naukri-bot-db-'));
    try {
      const file = join(dir, 'jobs.db');
      const first = openDatabase(file);
      insertJob(first, card(), 'AI');
      first.close();

      const second = openDatabase(file);
      expect(second.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
      expect(jobCounts(second, new Date(0)).total).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
