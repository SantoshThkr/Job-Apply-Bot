import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.ts';
import { createRun, runEvents } from '../src/db/runs.ts';
import type { ApplicationRow, BotEvent, Run } from '../src/domain.ts';
import { events, formatSse, recordRunEvent } from '../src/events.ts';
import { formatRunReport } from '../src/report.ts';

describe('SSE formatting', () => {
  it('writes one data line per event, even when messages contain newlines', () => {
    const event: BotEvent = { type: 'LOG', level: 'info', message: 'line one\nline two', timestamp: '2026-09-25T10:00:00.000Z' };
    const frame = formatSse(event);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(frame.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(frame.slice('data: '.length))).toEqual(event);
  });
});

describe('recordRunEvent', () => {
  it('saves the event for the timeline and publishes it live', () => {
    const db = openDatabase(':memory:');
    const runId = createRun(db, 'APPLY', {});
    const published: BotEvent[] = [];
    const listen = (event: BotEvent) => published.push(event);
    events.on('event', listen);
    try {
      const event = recordRunEvent(db, {
        type: 'NEEDS_REVIEW',
        runId,
        company: 'Acme',
        jobTitle: 'AI Engineer',
        status: 'NEEDS_REVIEW',
        message: 'Needs review: No answer configured',
        reason: 'UNKNOWN_REQUIRED_QUESTION',
        detail: { question: 'Are you willing to relocate?' },
      });
      expect(published).toEqual([event]);
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(runEvents(db, { runId })).toEqual([
        expect.objectContaining({
          type: 'NEEDS_REVIEW',
          reason: 'UNKNOWN_REQUIRED_QUESTION',
          detail: { question: 'Are you willing to relocate?' },
          createdAt: event.timestamp,
        }),
      ]);
    } finally {
      events.off('event', listen);
      db.close();
    }
  });
});

describe('formatRunReport', () => {
  const application = (overrides: Partial<ApplicationRow>): ApplicationRow => ({
    id: 1,
    runId: 'RUN-20260925-233612',
    jobId: 1,
    company: 'Acme',
    jobTitle: 'AI Engineer',
    matchScore: 92,
    status: 'APPLIED',
    outcome: 'applied',
    applyButtonFound: true,
    applyClicked: true,
    formOpened: false,
    formFilled: false,
    submitClicked: true,
    successConfirmed: true,
    failureCode: null,
    failureReason: null,
    question: null,
    externalUrl: null,
    startedAt: '2026-09-25T18:00:00.000Z',
    completedAt: '2026-09-25T18:00:10.000Z',
    ...overrides,
  });

  it('prints the run’s real counts and every job’s outcome with its reason', () => {
    const run: Run = {
      id: 'RUN-20260925-233612',
      kind: 'APPLY',
      status: 'STOPPED',
      startedAt: '2026-09-25T18:00:00.000Z',
      finishedAt: '2026-09-25T18:05:00.000Z',
      stopReason: 'Naukri is showing a security check (CAPTCHA/OTP).',
      stopCode: 'SECURITY_CHALLENGE',
      settings: {},
      stats: { queued: 3 },
      outcomes: { ready: 0, applying: 0, applied: 1, failed: 1, external: 0, review: 0, already_applied: 0 },
      attempted: 2,
    };
    const report = formatRunReport(run, [
      application({ id: 2, company: 'Beta', jobTitle: 'React Developer', status: 'FAILED', outcome: 'failed', failureCode: 'FORM_TIMEOUT', failureReason: 'The recruiter questions stopped responding' }),
      application({}),
    ]);
    expect(report).toContain('APPLICATION RUN STOPPED');
    expect(report).toContain('Reason: Naukri is showing a security check');
    expect(report).toMatch(/Queued\s+3/);
    expect(report).toMatch(/Attempted\s+2/);
    expect(report).toMatch(/Applied\s+1/);
    expect(report).not.toMatch(/External/);
    expect(report.indexOf('✓ Acme')).toBeLessThan(report.indexOf('✗ Beta'));
    expect(report).toContain('FAILED (FORM_TIMEOUT)');
    expect(report).toContain('Reason: The recruiter questions stopped responding');
  });
});
