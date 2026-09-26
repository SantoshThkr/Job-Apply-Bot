import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { insertRunEvent } from './db/runs.ts';
import type { BotEvent, RunEvent, RunEventType } from './domain.ts';
import { log } from './logger.ts';

// In-process only: the dashboard server relays these over SSE, the CLI ignores them.
export const events = new EventEmitter<{ event: [BotEvent] }>();

export function publish(event: BotEvent): void {
  events.emit('event', event);
}

const WARNINGS = new Set<RunEventType>(['NEEDS_REVIEW', 'SECURITY_CHALLENGE', 'APPLICATION_FAILED', 'RUN_STOPPED']);

// Saved first so a run's timeline survives the process, then logged and published.
export function recordRunEvent(db: DatabaseSync, event: Omit<RunEvent, 'timestamp'>, now = new Date()): RunEvent {
  const full: RunEvent = { ...event, timestamp: now.toISOString() };
  insertRunEvent(db, full);
  const line = [full.company && `${full.company} →`, full.message, full.reason && `(${full.reason})`].filter(Boolean).join(' ');
  if (full.type === 'RUN_FAILED') log.error(line);
  else if (WARNINGS.has(full.type)) log.warn(line);
  else log.info(line);
  publish(full);
  return full;
}

export function formatSse(event: BotEvent): string {
  // JSON.stringify never emits a raw newline, so one data: line always holds the whole event.
  return `data: ${JSON.stringify(event)}\n\n`;
}
