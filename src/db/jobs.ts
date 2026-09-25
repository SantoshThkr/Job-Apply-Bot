import type { DatabaseSync } from 'node:sqlite';
import type { JobCard, JobDetails } from '../jobs/normalization.ts';

export const JOB_STATUSES = [
  'DISCOVERED',
  'ANALYZED',
  'SHORTLISTED',
  'REVIEW',
  'SKIPPED',
  'ANALYSIS_FAILED',
  'APPLICATION_STARTED',
  'READY_TO_SUBMIT',
  'APPLIED',
  'FAILED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// Re-analysis may move a job between SHORTLISTED, REVIEW and SKIPPED; nothing leaves APPLIED.
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  DISCOVERED: ['ANALYZED', 'SHORTLISTED', 'REVIEW', 'SKIPPED', 'ANALYSIS_FAILED'],
  ANALYZED: ['SHORTLISTED', 'REVIEW', 'SKIPPED'],
  ANALYSIS_FAILED: ['DISCOVERED', 'SHORTLISTED', 'REVIEW', 'SKIPPED'],
  SHORTLISTED: ['REVIEW', 'SKIPPED', 'APPLICATION_STARTED'],
  REVIEW: ['SHORTLISTED', 'SKIPPED', 'APPLICATION_STARTED'],
  SKIPPED: ['DISCOVERED', 'SHORTLISTED', 'REVIEW'],
  APPLICATION_STARTED: ['READY_TO_SUBMIT', 'FAILED', 'SKIPPED'],
  READY_TO_SUBMIT: ['APPLIED', 'FAILED'],
  FAILED: ['APPLICATION_STARTED', 'SKIPPED'],
  APPLIED: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

// Jobs that keep failing (expired postings, removed pages) stop being retried after this.
const MAX_DETAIL_ATTEMPTS = 3;

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
       WHERE status = 'DISCOVERED' AND details_fetched_at IS NULL AND detail_attempts < ?
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


export function updateJobStatus(
  db: DatabaseSync,
  id: number,
  to: JobStatus,
  fields: { matchScore: number | null; filterReason: string | null; analysisError?: string | null },
  now = new Date(),
): void {
  const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: JobStatus } | undefined;
  if (!row) throw new Error(`Job ${id} does not exist`);
  if (!canTransition(row.status, to)) throw new Error(`Job ${id} cannot move from ${row.status} to ${to}`);
  db.prepare(
    `UPDATE jobs SET status = :to, match_score = :matchScore, filter_reason = :filterReason,
       analysis_error = :analysisError, updated_at = :now
     WHERE id = :id`,
  ).run({
    id,
    to,
    matchScore: fields.matchScore,
    filterReason: fields.filterReason,
    analysisError: fields.analysisError ?? null,
    now: now.toISOString(),
  });
}

export interface JobRow {
  id: number;
  title: string;
  company: string;
  location: string | null;
  workMode: 'Remote' | 'Hybrid' | 'Office' | null;
  experience: string | null;
  experienceMin: number | null;
  experienceMax: number | null;
  salary: string | null;
  skills: string[];
  description: string | null;
  status: JobStatus;
}

const JOB_COLUMNS = `id, title, company, location, work_mode AS workMode, experience, experience_min AS experienceMin,
  experience_max AS experienceMax, salary, skills, description, status`;

function toJobRow(row: Record<string, unknown>): JobRow {
  return { ...(row as unknown as JobRow), skills: JSON.parse(row.skills as string) as string[] };
}

// DISCOVERED jobs, plus with `recheck` the ones an earlier filter run rejected (the profile may have changed).
export function jobsToFilter(db: DatabaseSync, recheck: boolean): JobRow[] {
  return db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs
       WHERE status = 'DISCOVERED' OR (:recheck AND status = 'SKIPPED' AND filter_reason IS NOT NULL)
       ORDER BY id`,
    )
    .all({ recheck: Number(recheck) })
    .map(toJobRow);
}

// Jobs with a description that still need scoring; with `force`, earlier verdicts and failures are redone too.
export function jobsToAnalyze(db: DatabaseSync, force: boolean, limit: number): JobRow[] {
  return db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs
       WHERE description IS NOT NULL
         AND (status = 'DISCOVERED' OR (:force AND (status = 'ANALYSIS_FAILED'
              OR (status IN ('SHORTLISTED', 'REVIEW', 'SKIPPED') AND filter_reason IS NULL))))
       ORDER BY id LIMIT :limit`,
    )
    .all({ force: Number(force), limit })
    .map(toJobRow);
}

export function countAwaitingDetails(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT count(*) AS n FROM jobs WHERE status = 'DISCOVERED' AND description IS NULL AND detail_attempts < ?`)
    .get(MAX_DETAIL_ATTEMPTS) as { n: number };
  return row.n;
}
