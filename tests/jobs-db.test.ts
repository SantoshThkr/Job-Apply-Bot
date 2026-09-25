import { mkdtempSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.ts';
import { insertJob, jobCounts, jobsNeedingDetails, recentJobs, recordDetailFailure, saveJobDetails } from '../src/db/jobs.ts';
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
    expect(recentJobs(db, 5).map((j) => [j.title, j.hasDetails])).toEqual([
      ['ML Engineer', 0],
      ['AI Engineer', 1],
    ]);
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
      expect(second.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(jobCounts(second, new Date(0)).total).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
