import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from '../config.ts';

// Append-only. Each entry runs once; PRAGMA user_version records how many have run.
export const MIGRATIONS = [
  `CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    external_id TEXT UNIQUE,
    url TEXT NOT NULL UNIQUE,
    dedupe_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT,
    work_mode TEXT,
    experience TEXT,
    experience_min REAL,
    experience_max REAL,
    salary TEXT,
    salary_min_lakhs REAL,
    salary_max_lakhs REAL,
    skills TEXT NOT NULL DEFAULT '[]',
    employment_type TEXT,
    description TEXT,
    posted_at TEXT,
    external_apply INTEGER,
    search_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN (
      'DISCOVERED', 'ANALYZED', 'SHORTLISTED', 'REVIEW', 'SKIPPED',
      'APPLICATION_STARTED', 'READY_TO_SUBMIT', 'APPLIED', 'FAILED'
    )),
    match_score INTEGER,
    detail_attempts INTEGER NOT NULL DEFAULT 0,
    details_fetched_at TEXT,
    discovered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX jobs_status ON jobs (status);`,

  `ALTER TABLE jobs ADD COLUMN filter_reason TEXT;
  CREATE TABLE job_analysis (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    cache_key TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    evidence TEXT NOT NULL,
    score INTEGER NOT NULL,
    recommendation TEXT NOT NULL,
    matched_skills TEXT NOT NULL,
    missing_skills TEXT NOT NULL,
    red_flags TEXT NOT NULL,
    reason TEXT NOT NULL,
    breakdown TEXT NOT NULL,
    analyzed_at TEXT NOT NULL
  );
  CREATE INDEX job_analysis_job ON job_analysis (job_id);
  CREATE INDEX job_analysis_cache ON job_analysis (cache_key);`,

  // SQLite can't alter a CHECK constraint, so the table is rebuilt to allow ANALYSIS_FAILED.
  `CREATE TABLE jobs_rebuilt (
    id INTEGER PRIMARY KEY,
    external_id TEXT UNIQUE,
    url TEXT NOT NULL UNIQUE,
    dedupe_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT,
    work_mode TEXT,
    experience TEXT,
    experience_min REAL,
    experience_max REAL,
    salary TEXT,
    salary_min_lakhs REAL,
    salary_max_lakhs REAL,
    skills TEXT NOT NULL DEFAULT '[]',
    employment_type TEXT,
    description TEXT,
    posted_at TEXT,
    external_apply INTEGER,
    search_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN (
      'DISCOVERED', 'ANALYZED', 'SHORTLISTED', 'REVIEW', 'SKIPPED', 'ANALYSIS_FAILED',
      'APPLICATION_STARTED', 'READY_TO_SUBMIT', 'APPLIED', 'FAILED'
    )),
    match_score INTEGER,
    detail_attempts INTEGER NOT NULL DEFAULT 0,
    details_fetched_at TEXT,
    discovered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    filter_reason TEXT,
    analysis_error TEXT
  );
  INSERT INTO jobs_rebuilt SELECT *, NULL FROM jobs;
  DROP TABLE jobs;
  ALTER TABLE jobs_rebuilt RENAME TO jobs;
  CREATE INDEX jobs_status ON jobs (status);
  ALTER TABLE job_analysis ADD COLUMN provider TEXT NOT NULL DEFAULT '';`,

  // Runs (search, analysis, applying), one row per job an application run attempted, and each
  // attempt's step-by-step timeline. The flags record what actually happened in the browser.
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('SEARCH', 'ANALYZE', 'APPLY')),
    status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'STOPPED', 'FAILED')),
    settings TEXT NOT NULL DEFAULT '{}',
    stats TEXT NOT NULL DEFAULT '{}',
    stop_reason TEXT,
    stop_code TEXT,
    pid INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE applications (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    job_id INTEGER NOT NULL REFERENCES jobs (id),
    status TEXT NOT NULL CHECK (status IN (
      'STARTED', 'APPLY_CLICKED', 'FORM_OPENED', 'SUBMIT_CLICKED',
      'APPLIED', 'SUBMIT_UNVERIFIED', 'READY_TO_SUBMIT', 'NEEDS_REVIEW', 'ALREADY_APPLIED',
      'EXTERNAL_APPLICATION', 'APPLY_BUTTON_NOT_FOUND', 'SECURITY_CHALLENGE', 'FAILED', 'SKIPPED'
    )),
    match_score INTEGER,
    apply_button_found INTEGER NOT NULL DEFAULT 0,
    apply_clicked INTEGER NOT NULL DEFAULT 0,
    form_opened INTEGER NOT NULL DEFAULT 0,
    form_filled INTEGER NOT NULL DEFAULT 0,
    submit_clicked INTEGER NOT NULL DEFAULT 0,
    success_confirmed INTEGER NOT NULL DEFAULT 0,
    failure_code TEXT,
    failure_reason TEXT,
    question TEXT,
    external_url TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (run_id, job_id)
  );
  CREATE INDEX applications_job ON applications (job_id);
  CREATE TABLE run_events (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    application_id INTEGER REFERENCES applications (id),
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    reason TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX run_events_run ON run_events (run_id);
  CREATE INDEX run_events_application ON run_events (application_id);`,

  // Job profiles each job matches (JSON ids), the company-site URL for external jobs, paused runs,
  // and application states that say exactly how far an attempt got. Experience no longer filters
  // jobs, so anything the old experience filter set aside goes back to discovered. SQLite can't
  // alter a CHECK constraint, so runs and applications are rebuilt.
  `ALTER TABLE jobs ADD COLUMN profiles TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE jobs ADD COLUMN external_url TEXT;
  UPDATE jobs SET status = 'DISCOVERED', filter_reason = NULL
    WHERE status = 'SKIPPED' AND (filter_reason LIKE 'Needs %+ years%' OR filter_reason LIKE 'Aimed at up to %');

  CREATE TABLE runs_rebuilt (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('SEARCH', 'ANALYZE', 'APPLY')),
    status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED', 'FAILED')),
    settings TEXT NOT NULL DEFAULT '{}',
    stats TEXT NOT NULL DEFAULT '{}',
    stop_reason TEXT,
    stop_code TEXT,
    pid INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  INSERT INTO runs_rebuilt SELECT * FROM runs;
  DROP TABLE runs;
  ALTER TABLE runs_rebuilt RENAME TO runs;

  CREATE TABLE applications_rebuilt (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    job_id INTEGER NOT NULL REFERENCES jobs (id),
    status TEXT NOT NULL CHECK (status IN (
      'APPLYING', 'APPLY_CLICKED', 'FORM_OPENED', 'FORM_FILLED', 'SUBMIT_CLICKED',
      'READY_TO_APPLY', 'READY_TO_SUBMIT', 'APPLIED', 'FAILED', 'EXTERNAL', 'NEEDS_REVIEW',
      'ALREADY_APPLIED', 'SECURITY_CHALLENGE'
    )),
    match_score INTEGER,
    apply_button_found INTEGER NOT NULL DEFAULT 0,
    apply_clicked INTEGER NOT NULL DEFAULT 0,
    form_opened INTEGER NOT NULL DEFAULT 0,
    form_filled INTEGER NOT NULL DEFAULT 0,
    submit_clicked INTEGER NOT NULL DEFAULT 0,
    success_confirmed INTEGER NOT NULL DEFAULT 0,
    failure_code TEXT,
    failure_reason TEXT,
    question TEXT,
    external_url TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (run_id, job_id)
  );
  INSERT INTO applications_rebuilt
  SELECT id, run_id, job_id,
    CASE
      WHEN status = 'STARTED' THEN 'APPLYING'
      WHEN status = 'SUBMIT_UNVERIFIED' THEN 'NEEDS_REVIEW'
      WHEN status IN ('READY_TO_SUBMIT', 'SKIPPED') AND NOT apply_clicked THEN 'READY_TO_APPLY'
      WHEN status = 'SKIPPED' THEN 'FAILED'
      WHEN status = 'EXTERNAL_APPLICATION' THEN 'EXTERNAL'
      WHEN status = 'APPLY_BUTTON_NOT_FOUND' THEN 'FAILED'
      ELSE status
    END,
    match_score, apply_button_found, apply_clicked, form_opened, form_filled, submit_clicked, success_confirmed,
    CASE
      WHEN failure_code = 'AUTO_SUBMIT_OFF' THEN 'AUTO_APPLY_OFF'
      WHEN failure_code = 'NO_CONFIRMATION' OR status = 'SUBMIT_UNVERIFIED' THEN 'SUBMIT_UNVERIFIED'
      ELSE failure_code
    END,
    CASE WHEN failure_code = 'AUTO_SUBMIT_OFF' THEN 'Auto apply was off, so the bot did not click Apply' ELSE failure_reason END,
    question, external_url, started_at, completed_at
  FROM applications;
  DROP TABLE applications;
  ALTER TABLE applications_rebuilt RENAME TO applications;
  CREATE INDEX applications_job ON applications (job_id);
  CREATE INDEX applications_run ON applications (run_id);`,

  // The job's cities in canonical form ("Remote" for remote jobs), filled in when jobs are sorted
  // into profiles, so lists can filter by the locations picked on the dashboard.
  `ALTER TABLE jobs ADD COLUMN cities TEXT NOT NULL DEFAULT '[]';
  CREATE INDEX jobs_posted ON jobs (posted_at);`,
];

// A consistent copy (WAL included) taken before migrating, in data/backups/.
function backUp(db: DatabaseSync, file: string, version: number): void {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const dir = join(dirname(file), 'backups');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${basename(file, '.db')}-v${version}-${stamp}.db`);
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
}

export function openDatabase(file = paths.database): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const existed = file !== ':memory:' && existsSync(file);
  const db = new DatabaseSync(file);
  // WAL lets `npm run status` read while a search run is writing. node:sqlite turns foreign keys on
  // by default; they must be off while migrating, or rebuilding `jobs` cascade-deletes every analysis.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');

  const { user_version: applied } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (existed && applied > 0 && applied < MIGRATIONS.length) backUp(db, file, applied);
  for (let i = applied; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
