import type { DatabaseSync } from 'node:sqlite';
import type { JobCard, JobDetails } from '../jobs/normalization.ts';

export const JOB_STATUSES = [
  'DISCOVERED',
  'ANALYZED',
  'SHORTLISTED',
  'REVIEW',
  'SKIPPED',
  'APPLICATION_STARTED',
  'READY_TO_SUBMIT',
  'APPLIED',
  'FAILED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// Jobs that keep failing (expired postings, removed pages) stop being retried after this.
const MAX_DETAIL_ATTEMPTS = 3;

export interface StoredJob {
  id: number;
  title: string;
  company: string;
  location: string | null;
  experience: string | null;
  salary: string | null;
  postedAt: string | null;
  status: JobStatus;
  url: string;
  hasDetails: number;
}

// Returns false when the job is already stored under the same Naukri ID, URL or company/title/location.
export function insertJob(db: DatabaseSync, job: JobCard, searchName: string, now = new Date()): boolean {
  const result = db
    .prepare(
      `INSERT INTO jobs (
        external_id, url, dedupe_key, title, company, location, work_mode, experience, experience_min,
        experience_max, salary, salary_min_lakhs, salary_max_lakhs, skills, posted_at, external_apply,
        search_name, discovered_at, updated_at
      ) VALUES (
        :externalId, :url, :dedupeKey, :title, :company, :location, :workMode, :experience, :experienceMin,
        :experienceMax, :salary, :salaryMinLakhs, :salaryMaxLakhs, :skills, :postedAt, :externalApply,
        :searchName, :now, :now
      ) ON CONFLICT DO NOTHING`,
    )
    .run({
      externalId: job.externalId,
      url: job.url,
      dedupeKey: job.dedupeKey,
      title: job.title,
      company: job.company,
      location: job.location,
      workMode: job.workMode,
      experience: job.experience,
      experienceMin: job.experienceMin,
      experienceMax: job.experienceMax,
      salary: job.salary,
      salaryMinLakhs: job.salaryMinLakhs,
      salaryMaxLakhs: job.salaryMaxLakhs,
      skills: JSON.stringify(job.skills),
      postedAt: job.postedAt,
      externalApply: job.externalApply === null ? null : Number(job.externalApply),
      searchName,
      now: now.toISOString(),
    });
  return result.changes > 0;
}

export function jobsNeedingDetails(db: DatabaseSync, limit: number): { id: number; url: string; title: string; company: string }[] {
  return db
    .prepare(
      `SELECT id, url, title, company FROM jobs
       WHERE details_fetched_at IS NULL AND detail_attempts < ?
       ORDER BY id LIMIT ?`,
    )
    .all(MAX_DETAIL_ATTEMPTS, limit) as { id: number; url: string; title: string; company: string }[];
}

export function saveJobDetails(db: DatabaseSync, id: number, details: JobDetails, now = new Date()): void {
  db.prepare(
    `UPDATE jobs SET
       description = :description,
       skills = coalesce(:skills, skills),
       employment_type = coalesce(:employmentType, employment_type),
       posted_at = coalesce(:postedAt, posted_at),
       work_mode = coalesce(:workMode, work_mode),
       details_fetched_at = :now,
       updated_at = :now
     WHERE id = :id`,
  ).run({
    id,
    description: details.description,
    skills: details.skills.length ? JSON.stringify(details.skills) : null,
    employmentType: details.employmentType,
    postedAt: details.postedAt,
    workMode: details.workMode,
    now: now.toISOString(),
  });
}

export function recordDetailFailure(db: DatabaseSync, id: number, now = new Date()): void {
  db.prepare('UPDATE jobs SET detail_attempts = detail_attempts + 1, updated_at = ? WHERE id = ?').run(now.toISOString(), id);
}

export function jobCounts(db: DatabaseSync, since: Date): {
  total: number;
  discoveredSince: number;
  withDetails: number;
  byStatus: Partial<Record<JobStatus, number>>;
} {
  const totals = db
    .prepare(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE discovered_at >= ?) AS discoveredSince,
              count(details_fetched_at) AS withDetails
       FROM jobs`,
    )
    .get(since.toISOString()) as { total: number; discoveredSince: number; withDetails: number };
  const rows = db.prepare('SELECT status, count(*) AS count FROM jobs GROUP BY status').all() as {
    status: JobStatus;
    count: number;
  }[];
  return { ...totals, byStatus: Object.fromEntries(rows.map((r) => [r.status, r.count])) };
}

export function recentJobs(db: DatabaseSync, limit: number): StoredJob[] {
  return db
    .prepare(
      `SELECT id, title, company, location, experience, salary, posted_at AS postedAt, status, url,
              details_fetched_at IS NOT NULL AS hasDetails
       FROM jobs ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as unknown as StoredJob[];
}
