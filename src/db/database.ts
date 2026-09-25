import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
];

export function openDatabase(file = paths.database): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL lets `npm run status` read while a search run is writing. node:sqlite turns foreign keys on
  // by default; they must be off while migrating, or rebuilding `jobs` cascade-deletes every analysis.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');

  const { user_version: applied } = db.prepare('PRAGMA user_version').get() as { user_version: number };
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
