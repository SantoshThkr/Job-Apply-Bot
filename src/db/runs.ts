import type { DatabaseSync } from 'node:sqlite';
import type { EventDetail, Run, RunEvent, RunEventRecord, RunKind, RunStatus, StopCode } from '../domain.ts';
import { runOutcomes } from './applications.ts';

const pad = (n: number) => String(n).padStart(2, '0');

// RUN-20260925-233612, from local time so it matches what the user saw on the clock.
function newRunId(db: DatabaseSync, now: Date): string {
  const base = `RUN-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const exists = db.prepare('SELECT 1 FROM runs WHERE id = ?');
  let id = base;
  for (let n = 2; exists.get(id); n++) id = `${base}-${n}`;
  return id;
}

export function createRun(db: DatabaseSync, kind: RunKind, settings: Run['settings'], now = new Date()): string {
  const id = newRunId(db, now);
  db.prepare('INSERT INTO runs (id, kind, settings, pid, started_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    kind,
    JSON.stringify(settings),
    process.pid,
    now.toISOString(),
  );
  return id;
}

// PAUSED while an application run waits to be resumed; RUNNING again after.
export function setRunPaused(db: DatabaseSync, id: string, paused: boolean): void {
  db.prepare(`UPDATE runs SET status = ? WHERE id = ? AND status IN ('RUNNING', 'PAUSED')`).run(paused ? 'PAUSED' : 'RUNNING', id);
}

export function finishRun(
  db: DatabaseSync,
  id: string,
  status: Exclude<RunStatus, 'RUNNING'>,
  { stats, stopReason = null, stopCode = null }: { stats: Run['stats']; stopReason?: string | null; stopCode?: StopCode | null },
  now = new Date(),
): void {
  db.prepare(
    `UPDATE runs SET status = ?, stats = ?, stop_reason = ?, stop_code = ?, finished_at = ? WHERE id = ? AND status IN ('RUNNING', 'PAUSED')`,
  ).run(status, JSON.stringify(stats), stopReason, stopCode, now.toISOString(), id);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// Runs whose process exited without finishing them (crash, closed terminal). Attempts they left
// mid-way are closed honestly: once Apply was clicked, nobody knows whether Naukri got it.
export function closeAbandonedRuns(db: DatabaseSync, now = new Date()): string[] {
  const abandoned = (db.prepare(`SELECT id, pid FROM runs WHERE status IN ('RUNNING', 'PAUSED')`).all() as { id: string; pid: number | null }[])
    .filter((run) => run.pid === null || (run.pid !== process.pid && !alive(run.pid)))
    .map((run) => run.id);
  for (const id of abandoned) {
    db.prepare(
      `UPDATE applications SET
         status = CASE WHEN apply_clicked AND (NOT form_opened OR submit_clicked) THEN 'NEEDS_REVIEW' ELSE 'FAILED' END,
         failure_code = 'INTERRUPTED',
         failure_reason = 'The bot stopped unexpectedly during this application',
         completed_at = :now
       WHERE run_id = :id AND status IN ('APPLYING', 'APPLY_CLICKED', 'FORM_OPENED', 'FORM_FILLED', 'SUBMIT_CLICKED')`,
    ).run({ id, now: now.toISOString() });
    finishRun(db, id, 'FAILED', { stats: runStats(db, id), stopReason: 'The process running it exited before it finished' }, now);
  }
  return abandoned;
}

function runStats(db: DatabaseSync, id: string): Run['stats'] {
  const row = db.prepare('SELECT stats FROM runs WHERE id = ?').get(id) as { stats: string } | undefined;
  return row ? JSON.parse(row.stats) : {};
}

const RUN_COLUMNS = `id, kind, status, started_at AS startedAt, finished_at AS finishedAt, stop_reason AS stopReason,
  stop_code AS stopCode, settings, stats`;

function toRun(db: DatabaseSync, row: Record<string, unknown>): Run {
  return {
    ...(row as unknown as Run),
    settings: JSON.parse(row.settings as string),
    stats: JSON.parse(row.stats as string),
    ...runOutcomes(db, row.id as string),
  };
}

export function getRun(db: DatabaseSync, id: string): Run | undefined {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row && toRun(db, row);
}

export function listRuns(db: DatabaseSync, { kind, limit = 100 }: { kind?: RunKind; limit?: number } = {}): Run[] {
  return (
    db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE :kind IS NULL OR kind = :kind ORDER BY started_at DESC, rowid DESC LIMIT :limit`)
      .all({ kind: kind ?? null, limit }) as Record<string, unknown>[]
  ).map((row) => toRun(db, row));
}

export function insertRunEvent(db: DatabaseSync, event: RunEvent): void {
  db.prepare(
    `INSERT INTO run_events (run_id, application_id, type, message, reason, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.runId,
    event.applicationId ?? null,
    event.type,
    event.message,
    event.reason ?? null,
    event.detail ? JSON.stringify(event.detail) : null,
    event.timestamp,
  );
}

// A run's own events (started, paused, stopped...), or one attempt's steps.
export function runEvents(db: DatabaseSync, filter: { runId: string } | { applicationId: number }): RunEventRecord[] {
  const where = 'runId' in filter ? 'run_id = ? AND application_id IS NULL' : 'application_id = ?';
  const rows = db
    .prepare(
      `SELECT id, application_id AS applicationId, type, message, reason, detail, created_at AS createdAt
       FROM run_events WHERE ${where} ORDER BY id`,
    )
    .all('runId' in filter ? filter.runId : filter.applicationId) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...(row as unknown as RunEventRecord),
    detail: row.detail ? (JSON.parse(row.detail as string) as EventDetail) : null,
  }));
}
