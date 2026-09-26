import type { DatabaseSync } from 'node:sqlite';
import type { MatchEvidence } from '../ai/schemas.ts';
import {
  OUTCOMES,
  freshSince,
  type JobCategory,
  type JobDetail,
  type JobListItem,
  type JobPage,
  type JobScope,
  type JobStatus,
} from '../domain.ts';
import type { JobCard, JobDetails } from '../jobs/normalization.ts';

// Re-analysis may move a job between SHORTLISTED, REVIEW and SKIPPED; nothing leaves APPLIED.
// Attempts live in the applications table; a job only changes here once Naukri confirms it applied.
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  DISCOVERED: ['ANALYZED', 'SHORTLISTED', 'REVIEW', 'SKIPPED', 'ANALYSIS_FAILED'],
  ANALYZED: ['SHORTLISTED', 'REVIEW', 'SKIPPED'],
  ANALYSIS_FAILED: ['DISCOVERED', 'SHORTLISTED', 'REVIEW', 'SKIPPED'],
  SHORTLISTED: ['REVIEW', 'SKIPPED', 'APPLICATION_STARTED', 'APPLIED'],
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

// Rows of `jobs j` inside a scope: matching any of the chosen profiles and posted within the
// freshness window. Jobs without a posting date only show up under "all".
export const IN_SCOPE = `(:profiles IS NULL OR EXISTS (
    SELECT 1 FROM json_each(j.profiles) p JOIN json_each(:profiles) chosen ON chosen.value = p.value))
  AND (:since IS NULL OR julianday(j.posted_at) >= julianday(:since))`;

export function scopeParams(scope: JobScope, now = new Date()): { profiles: string | null; since: string | null } {
  return { profiles: scope.profiles.length ? JSON.stringify(scope.profiles) : null, since: freshSince(scope.freshness, now) };
}

const ALL: JobScope = { profiles: [], freshness: 'all' };

// Freshest first; -1 means no limit.
export function jobsNeedingDetails(
  db: DatabaseSync,
  { scope = ALL, limit = -1 }: { scope?: JobScope; limit?: number } = {},
): { id: number; url: string; title: string; company: string }[] {
  return db
    .prepare(
      `SELECT j.id, j.url, j.title, j.company FROM jobs j
       WHERE j.status = 'DISCOVERED' AND j.details_fetched_at IS NULL AND j.detail_attempts < :maxAttempts AND ${IN_SCOPE}
       ORDER BY julianday(j.posted_at) DESC NULLS LAST, j.id LIMIT :limit`,
    )
    .all({ maxAttempts: MAX_DETAIL_ATTEMPTS, limit, ...scopeParams(scope) }) as { id: number; url: string; title: string; company: string }[];
}

export function saveJobDetails(db: DatabaseSync, id: number, details: JobDetails & { externalUrl?: string | null }, now = new Date()): void {
  // The search results carry the exact posting time, which the description page only gives as a date.
  db.prepare(
    `UPDATE jobs SET
       description = :description,
       skills = coalesce(:skills, skills),
       employment_type = coalesce(:employmentType, employment_type),
       posted_at = coalesce(posted_at, :postedAt),
       work_mode = coalesce(:workMode, work_mode),
       external_url = coalesce(:externalUrl, external_url),
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
    externalUrl: details.externalUrl ?? null,
    now: now.toISOString(),
  });
}

export function setJobProfiles(db: DatabaseSync, id: number, profiles: string[]): void {
  db.prepare('UPDATE jobs SET profiles = ? WHERE id = ?').run(JSON.stringify(profiles), id);
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

export function markJobApplied(db: DatabaseSync, id: number, now = new Date()): void {
  const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: JobStatus } | undefined;
  if (!row) throw new Error(`Job ${id} does not exist`);
  if (!canTransition(row.status, 'APPLIED')) throw new Error(`Job ${id} cannot move from ${row.status} to APPLIED`);
  db.prepare(`UPDATE jobs SET status = 'APPLIED', updated_at = ? WHERE id = ?`).run(now.toISOString(), id);
}

// The simple status a job shows: its latest attempt's outcome, or, for a job never attempted, how far
// matching got. Needs the `:outcomes` parameter (JSON of OUTCOMES) and the latest attempt as `ap`.
export const JOB_CATEGORY = `CASE
    WHEN j.status = 'APPLIED' THEN CASE
      WHEN EXISTS (SELECT 1 FROM applications x WHERE x.job_id = j.id AND x.status = 'APPLIED') THEN 'applied'
      ELSE 'already_applied' END
    WHEN ap.status IS NOT NULL THEN :outcomes ->> ('$.' || ap.status)
    WHEN j.status = 'SHORTLISTED' AND j.external_apply THEN 'external'
    WHEN j.status = 'SHORTLISTED' THEN 'ready'
    WHEN j.status IN ('DISCOVERED', 'ANALYSIS_FAILED') THEN 'new'
    WHEN j.status = 'SKIPPED' AND j.filter_reason IS NOT NULL THEN 'filtered'
    ELSE 'low_match'
  END`;

const LIST_COLUMNS = `j.id, j.company, j.title, j.location, j.experience, j.posted_at AS postedAt, j.match_score AS score,
  a.recommendation AS band, j.profiles, j.status AS jobStatus, ap.status AS applicationStatus, ${JOB_CATEGORY} AS category`;

const LATEST_JOINS = `LEFT JOIN job_analysis a ON a.id = (SELECT max(id) FROM job_analysis WHERE job_id = j.id)
  LEFT JOIN applications ap ON ap.id = (SELECT max(id) FROM applications WHERE job_id = j.id)`;

const toListItem = (row: Record<string, unknown>): JobListItem => ({ ...(row as unknown as JobListItem), profiles: JSON.parse(row.profiles as string) });

// Jobs still to act on come first, then the rest; freshest first within each.
export function listJobs(
  db: DatabaseSync,
  {
    scope = ALL,
    category = 'all',
    limit = 100,
    offset = 0,
    now = new Date(),
  }: { scope?: JobScope; category?: JobCategory | 'all'; limit?: number; offset?: number; now?: Date } = {},
): JobPage {
  const rows = db
    .prepare(
      `SELECT *, count(*) OVER () AS total FROM (
         SELECT ${LIST_COLUMNS}, j.discovered_at AS discoveredAt FROM jobs j ${LATEST_JOINS} WHERE ${IN_SCOPE}
       )
       WHERE :category = 'all' OR category = :category
       ORDER BY CASE category WHEN 'applying' THEN 0 WHEN 'ready' THEN 1 WHEN 'new' THEN 2 ELSE 3 END,
                julianday(postedAt) DESC NULLS LAST, discoveredAt DESC, id DESC
       LIMIT :limit OFFSET :offset`,
    )
    .all({ outcomes: JSON.stringify(OUTCOMES), category, limit, offset, ...scopeParams(scope, now) }) as Record<string, unknown>[];
  return {
    jobs: rows.map(({ total: _, discoveredAt: __, ...job }) => toListItem(job)),
    total: (rows[0]?.total as number | undefined) ?? 0,
  };
}

export function getJobDetail(db: DatabaseSync, id: number): Omit<JobDetail, 'applications'> | undefined {
  const row = db
    .prepare(
      `SELECT ${LIST_COLUMNS}, j.url, j.salary, j.work_mode AS workMode, j.skills, j.description,
              j.discovered_at AS discoveredAt, j.external_apply AS externalApply, j.external_url AS externalUrl,
              j.filter_reason AS filterReason, j.analysis_error AS analysisError,
              a.provider, a.model, a.analyzed_at AS analyzedAt, a.evidence, a.reason, a.matched_skills AS matchedSkills,
              a.missing_skills AS missingSkills, a.red_flags AS redFlags, a.breakdown, a.score AS analysisScore
       FROM jobs j ${LATEST_JOINS} WHERE j.id = :id`,
    )
    .get({ id, outcomes: JSON.stringify(OUTCOMES) }) as Record<string, unknown> | undefined;
  if (!row) return undefined;

  const { provider, model, analyzedAt, evidence, reason, matchedSkills, missingSkills, redFlags, breakdown, analysisScore, ...job } = row;
  let analysis: JobDetail['analysis'] = null;
  if (typeof evidence === 'string') {
    const facts = JSON.parse(evidence) as MatchEvidence;
    const { missingPreferredSkills = [], holdReason = null } = JSON.parse(breakdown as string) as {
      missingPreferredSkills?: string[];
      holdReason?: string | null;
    };
    analysis = {
      provider: provider as string,
      model: model as string,
      analyzedAt: analyzedAt as string,
      score: analysisScore as number,
      band: row.band as NonNullable<JobDetail['band']>,
      reason: reason as string,
      requiredSkills: facts.requiredSkills.map((s) => s.skill),
      preferredSkills: facts.preferredSkills.map((s) => s.skill),
      matchedSkills: JSON.parse(matchedSkills as string),
      missingSkills: JSON.parse(missingSkills as string),
      missingPreferredSkills,
      redFlags: JSON.parse(redFlags as string),
      holdReason,
    };
  }
  return {
    ...(job as unknown as Omit<JobDetail, 'applications'>),
    profiles: JSON.parse(job.profiles as string),
    skills: JSON.parse(job.skills as string),
    externalApply: job.externalApply === null ? null : Boolean(job.externalApply),
    analysis,
  };
}

export interface JobRow {
  id: number;
  title: string;
  company: string;
  location: string | null;
  workMode: 'Remote' | 'Hybrid' | 'Office' | null;
  experience: string | null;
  salary: string | null;
  skills: string[];
  description: string | null;
  status: JobStatus;
  filterReason: string | null;
  profiles: string[];
}

const JOB_COLUMNS = `j.id, j.title, j.company, j.location, j.work_mode AS workMode, j.experience, j.salary, j.skills,
  j.description, j.status, j.filter_reason AS filterReason, j.profiles`;

function toJobRow(row: Record<string, unknown>): JobRow {
  return { ...(row as unknown as JobRow), skills: JSON.parse(row.skills as string), profiles: JSON.parse(row.profiles as string) };
}

export type ClassifiableJob = Omit<JobRow, 'description' | 'experience' | 'salary'>;

// Every job without its description, for matching against the job profiles: cheap enough to redo
// whenever the profiles change.
export function allJobs(db: DatabaseSync): ClassifiableJob[] {
  return db
    .prepare(
      `SELECT j.id, j.title, j.company, j.location, j.work_mode AS workMode, j.skills, j.status,
              j.filter_reason AS filterReason, j.profiles
       FROM jobs j ORDER BY j.id`,
    )
    .all()
    .map((row) => ({ ...(row as unknown as ClassifiableJob), skills: JSON.parse(row.skills as string), profiles: JSON.parse(row.profiles as string) }));
}

// Jobs with a description that still need scoring, freshest first; with `force`, earlier verdicts and
// failures are redone too. -1 means no limit.
export function jobsToAnalyze(
  db: DatabaseSync,
  { force = false, scope = ALL, limit = -1 }: { force?: boolean; scope?: JobScope; limit?: number } = {},
): JobRow[] {
  return db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs j
       WHERE j.description IS NOT NULL AND ${IN_SCOPE}
         AND (j.status = 'DISCOVERED' OR (:force AND (j.status = 'ANALYSIS_FAILED'
              OR (j.status IN ('SHORTLISTED', 'REVIEW', 'SKIPPED') AND j.filter_reason IS NULL))))
       ORDER BY julianday(j.posted_at) DESC NULLS LAST, j.id LIMIT :limit`,
    )
    .all({ force: Number(force), limit, ...scopeParams(scope) })
    .map(toJobRow);
}

export function countAwaitingDetails(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT count(*) AS n FROM jobs WHERE status = 'DISCOVERED' AND description IS NULL AND detail_attempts < ?`)
    .get(MAX_DETAIL_ATTEMPTS) as { n: number };
  return row.n;
}
