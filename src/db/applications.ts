import type { DatabaseSync } from 'node:sqlite';
import {
  OUTCOMES,
  type ApplicationRow,
  type ApplicationStatus,
  type FailureCode,
  type JobCategory,
  type JobScope,
  type OutcomeCounts,
  type ScopeSummary,
} from '../domain.ts';
import { IN_SCOPE, JOB_CATEGORY, categoryParams, scopeParams } from './jobs.ts';

// Attempts only move forward. APPLIED needs SUBMIT_CLICKED first and a confirmed success (checked in
// updateApplication). Once a click may have sent the application (Apply on a job without questions,
// or the last answer), the attempt only ends in FAILED on Naukri's own error message; without any
// evidence it ends in NEEDS_REVIEW.
const TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  APPLYING: ['APPLY_CLICKED', 'READY_TO_APPLY', 'ALREADY_APPLIED', 'EXTERNAL', 'SECURITY_CHALLENGE', 'FAILED'],
  APPLY_CLICKED: ['FORM_OPENED', 'SUBMIT_CLICKED', 'EXTERNAL', 'NEEDS_REVIEW', 'FAILED'],
  FORM_OPENED: ['FORM_FILLED', 'SUBMIT_CLICKED', 'NEEDS_REVIEW', 'SECURITY_CHALLENGE', 'FAILED'],
  FORM_FILLED: ['SUBMIT_CLICKED', 'READY_TO_SUBMIT', 'NEEDS_REVIEW', 'SECURITY_CHALLENGE', 'FAILED'],
  SUBMIT_CLICKED: ['APPLIED', 'NEEDS_REVIEW', 'FAILED'],
  READY_TO_APPLY: [],
  READY_TO_SUBMIT: [],
  APPLIED: [],
  FAILED: [],
  EXTERNAL: [],
  NEEDS_REVIEW: [],
  ALREADY_APPLIED: [],
  SECURITY_CHALLENGE: [],
};

export const IN_PROGRESS = (Object.keys(OUTCOMES) as ApplicationStatus[]).filter((s) => OUTCOMES[s] === 'applying');

export function canTransitionApplication(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function startApplication(
  db: DatabaseSync,
  runId: string,
  job: { jobId: number; score: number | null },
  now = new Date(),
): number {
  const result = db
    .prepare(`INSERT INTO applications (run_id, job_id, status, match_score, started_at) VALUES (?, ?, 'APPLYING', ?, ?)`)
    .run(runId, job.jobId, job.score, now.toISOString());
  return Number(result.lastInsertRowid);
}

export interface ApplicationChanges {
  status?: ApplicationStatus;
  applyButtonFound?: boolean;
  applyClicked?: boolean;
  formOpened?: boolean;
  formFilled?: boolean;
  submitClicked?: boolean;
  successConfirmed?: boolean;
  failureCode?: FailureCode | null;
  failureReason?: string | null;
  question?: string | null;
  externalUrl?: string | null;
}

export function updateApplication(db: DatabaseSync, id: number, changes: ApplicationChanges, now = new Date()): ApplicationRow {
  const current = getApplication(db, id);
  if (!current) throw new Error(`Application ${id} does not exist`);
  if (changes.status && !canTransitionApplication(current.status, changes.status)) {
    throw new Error(`Application ${id} cannot move from ${current.status} to ${changes.status}`);
  }
  // An explicit undefined means "leave it", not "clear it".
  const next = { ...current, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) };
  if (next.status === 'APPLIED' && !next.successConfirmed) {
    throw new Error(`Application ${id} cannot be APPLIED without a confirmed success`);
  }
  const outcome = OUTCOMES[next.status];
  const completedAt = outcome === 'applying' ? null : (current.completedAt ?? now.toISOString());
  db.prepare(
    `UPDATE applications SET
       status = :status, apply_button_found = :applyButtonFound, apply_clicked = :applyClicked,
       form_opened = :formOpened, form_filled = :formFilled, submit_clicked = :submitClicked,
       success_confirmed = :successConfirmed, failure_code = :failureCode, failure_reason = :failureReason,
       question = :question, external_url = :externalUrl, completed_at = :completedAt
     WHERE id = :id`,
  ).run({
    id,
    status: next.status,
    applyButtonFound: Number(next.applyButtonFound),
    applyClicked: Number(next.applyClicked),
    formOpened: Number(next.formOpened),
    formFilled: Number(next.formFilled),
    submitClicked: Number(next.submitClicked),
    successConfirmed: Number(next.successConfirmed),
    failureCode: next.failureCode,
    failureReason: next.failureReason,
    question: next.question,
    externalUrl: next.externalUrl,
    completedAt,
  });
  return { ...next, outcome, completedAt };
}

const APPLICATION_COLUMNS = `ap.id, ap.run_id AS runId, ap.job_id AS jobId, j.company, j.title AS jobTitle, j.url,
  ap.match_score AS matchScore, ap.status, ap.apply_button_found AS applyButtonFound, ap.apply_clicked AS applyClicked,
  ap.form_opened AS formOpened, ap.form_filled AS formFilled, ap.submit_clicked AS submitClicked,
  ap.success_confirmed AS successConfirmed, ap.failure_code AS failureCode, ap.failure_reason AS failureReason,
  ap.question, ap.external_url AS externalUrl, ap.started_at AS startedAt, ap.completed_at AS completedAt`;

const FLAGS = ['applyButtonFound', 'applyClicked', 'formOpened', 'formFilled', 'submitClicked', 'successConfirmed'] as const;

function toApplication(row: Record<string, unknown>): ApplicationRow & { url: string } {
  const application = { ...row } as unknown as ApplicationRow & { url: string };
  for (const flag of FLAGS) application[flag] = Boolean(row[flag]);
  application.outcome = OUTCOMES[application.status];
  return application;
}

export function getApplication(db: DatabaseSync, id: number): (ApplicationRow & { url: string }) | undefined {
  const row = db.prepare(`SELECT ${APPLICATION_COLUMNS} FROM applications ap JOIN jobs j ON j.id = ap.job_id WHERE ap.id = ?`).get(id);
  return row && toApplication(row as Record<string, unknown>);
}

export function listApplications(
  db: DatabaseSync,
  { runId, jobId, limit = -1 }: { runId?: string; jobId?: number; limit?: number } = {},
): ApplicationRow[] {
  return (
    db
      .prepare(
        `SELECT ${APPLICATION_COLUMNS} FROM applications ap JOIN jobs j ON j.id = ap.job_id
         WHERE (:runId IS NULL OR ap.run_id = :runId) AND (:jobId IS NULL OR ap.job_id = :jobId)
         ORDER BY ap.id DESC LIMIT :limit`,
      )
      .all({ runId: runId ?? null, jobId: jobId ?? null, limit }) as Record<string, unknown>[]
  ).map(toApplication);
}

// The earlier attempt that got this job applied, if any.
export function previousApplication(db: DatabaseSync, jobId: number): { runId: string; appliedAt: string } | undefined {
  return db
    .prepare(
      `SELECT run_id AS runId, coalesce(completed_at, started_at) AS appliedAt FROM applications
       WHERE job_id = ? AND status IN ('APPLIED', 'ALREADY_APPLIED') ORDER BY id DESC LIMIT 1`,
    )
    .get(jobId) as { runId: string; appliedAt: string } | undefined;
}

const emptyCounts = (): OutcomeCounts => ({ ready: 0, applying: 0, applied: 0, failed: 0, external: 0, review: 0, already_applied: 0 });

// Where every attempt in one run ended.
export function runOutcomes(db: DatabaseSync, runId: string): { outcomes: OutcomeCounts; attempted: number } {
  const outcomes = emptyCounts();
  let attempted = 0;
  const rows = db.prepare('SELECT status, count(*) AS n FROM applications WHERE run_id = ? GROUP BY status').all(runId) as {
    status: ApplicationStatus;
    n: number;
  }[];
  for (const { status, n } of rows) {
    outcomes[OUTCOMES[status]] += n;
    attempted += n;
  }
  return { outcomes, attempted };
}

export interface QueueItem {
  jobId: number;
  company: string;
  title: string;
  score: number | null;
  url: string;
  postedAt: string | null;
  hasDescription: boolean;
}

interface QueueRow extends QueueItem {
  jobStatus: string;
  category: JobCategory;
  externalApply: number | null;
  lastStatus: ApplicationStatus | null;
  lastCode: FailureCode | null;
  lastQuestion: string | null;
  lastRunId: string | null;
  lastClicked: number | null;
  lastFormOpened: number | null;
  lastSubmitted: number | null;
  failures: number;
}

// A job that keeps failing for the same reason isn't retried forever.
const MAX_FAILURES = 3;

// Why a job in scope is left out of an application run, or null when it can be attempted.
function exclusionReason(row: QueueRow, isAnswered: (question: string) => boolean): string | null {
  if (row.jobStatus === 'APPLIED') return 'Already applied';
  if (row.externalApply) return "Applies on the company's site";
  if (row.category === 'not_eligible') return 'Not eligible';
  switch (row.lastStatus) {
    case null:
    case 'READY_TO_APPLY':
    case 'READY_TO_SUBMIT':
    case 'SECURITY_CHALLENGE':
      return null;
    case 'EXTERNAL':
      return "Applies on the company's site";
    case 'APPLIED':
    case 'ALREADY_APPLIED':
      return 'Already applied';
    case 'NEEDS_REVIEW':
      // Possibly sent already (a submit, or Apply on a job without questions): never click again
      // without someone checking Naukri first.
      if (row.lastSubmitted || (row.lastClicked && !row.lastFormOpened)) {
        return `Possibly sent in ${row.lastRunId} but not confirmed by Naukri; check it on Naukri`;
      }
      if (row.lastCode === 'UNKNOWN_REQUIRED_QUESTION' && row.lastQuestion && isAnswered(row.lastQuestion)) return null;
      return row.lastQuestion ? `Needs an answer to "${row.lastQuestion}"` : `Needs review since ${row.lastRunId}`;
    case 'FAILED':
      if (row.lastCode === 'JOB_UNAVAILABLE') return 'The posting no longer accepts applications';
      if (row.lastCode === 'APPLY_BUTTON_NOT_FOUND') return 'No Apply button on the job page';
      return row.failures >= MAX_FAILURES ? `Failed ${row.failures} times` : null;
    default:
      return `Being applied to in ${row.lastRunId}`;
  }
}

export interface QueueOptions {
  scope: JobScope;
  minMatchScore: number;
  isAnswered: (question: string) => boolean;
  now?: Date;
}

// Every job in scope that can be applied to now, freshest first. No cap: a run works through all of them.
export function applicationQueue(
  db: DatabaseSync,
  { scope, minMatchScore, isAnswered, now = new Date() }: QueueOptions,
): { jobs: QueueItem[]; excluded: { jobId: number; reason: string }[] } {
  const rows = db
    .prepare(
      `SELECT j.id AS jobId, j.company, j.title, j.match_score AS score, j.url, j.posted_at AS postedAt, j.status AS jobStatus,
              j.description IS NOT NULL AS hasDescription,
              ${JOB_CATEGORY} AS category, j.external_apply AS externalApply, ap.status AS lastStatus, ap.failure_code AS lastCode,
              ap.question AS lastQuestion, ap.run_id AS lastRunId, ap.apply_clicked AS lastClicked,
              ap.form_opened AS lastFormOpened, ap.submit_clicked AS lastSubmitted,
              (SELECT count(*) FROM applications f WHERE f.job_id = j.id AND f.status = 'FAILED'
                 AND coalesce(f.failure_code, '') NOT IN ('RUN_STOPPED', 'INTERRUPTED', 'BROWSER_CLOSED')) AS failures
       FROM jobs j
       LEFT JOIN applications ap ON ap.id = (SELECT max(id) FROM applications WHERE job_id = j.id)
       WHERE ${IN_SCOPE}
       ORDER BY julianday(j.posted_at) DESC NULLS LAST, j.id DESC`,
    )
    .all({ ...categoryParams(scope, minMatchScore), ...scopeParams(scope, now) }) as unknown as QueueRow[];

  const jobs: QueueItem[] = [];
  const excluded: { jobId: number; reason: string }[] = [];
  for (const row of rows) {
    const reason = exclusionReason(row, isAnswered);
    if (reason) excluded.push({ jobId: row.jobId, reason });
    else {
      const { jobId, company, title, score, url, postedAt } = row;
      jobs.push({ jobId, company, title, score, url, postedAt, hasDescription: Boolean(row.hasDescription) });
    }
  }
  return { jobs, excluded };
}

const emptyCategories = (): Record<JobCategory, number> => ({ ...emptyCounts(), not_eligible: 0 });

// Where the jobs in scope stand. Each job counts once, by its status.
export function scopeSummary(db: DatabaseSync, options: QueueOptions): Omit<ScopeSummary, 'problems' | 'minMatchScore'> {
  const { scope, minMatchScore, now = new Date() } = options;
  const rows = db
    .prepare(
      `SELECT category, count(*) AS n FROM (
         SELECT ${JOB_CATEGORY} AS category FROM jobs j
         LEFT JOIN applications ap ON ap.id = (SELECT max(id) FROM applications WHERE job_id = j.id)
         WHERE ${IN_SCOPE}
       ) GROUP BY category`,
    )
    .all({ ...categoryParams(scope, minMatchScore), ...scopeParams(scope, now) }) as { category: JobCategory; n: number }[];
  const counts = emptyCategories();
  for (const { category, n } of rows) counts[category] += n;
  const found = Object.values(counts).reduce((a, b) => a + b, 0);
  return { found, eligible: found - counts.not_eligible, counts, queued: applicationQueue(db, options).jobs.length };
}
