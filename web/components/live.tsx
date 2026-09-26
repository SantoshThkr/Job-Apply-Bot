'use client';

import type { RunEvent, RunEventType } from '@bot/domain';
import { useState } from 'react';
import { post } from '@/lib/api';
import { useLive } from '@/lib/live';
import { Button, ErrorText, StatusBadge } from './ui';

const STEP_SYMBOLS: Partial<Record<RunEventType, string>> = {
  FORM_FIELD_DETECTED: '?',
  READY_TO_SUBMIT: '○',
  FORM_SUBMITTED: '→',
  READY_TO_APPLY: '○',
  NEEDS_REVIEW: '!',
  EXTERNAL_APPLICATION: '→',
  APPLICATION_FAILED: '✗',
  SECURITY_CHALLENGE: '⚠',
};

function Step({ event }: { event: RunEvent }) {
  const symbol = STEP_SYMBOLS[event.type] ?? '✓';
  const tone = symbol === '✗' || symbol === '⚠' ? 'text-red-700' : symbol === '!' || symbol === '?' ? 'text-amber-800' : 'text-slate-800';
  return (
    <li className={tone}>
      <span aria-hidden="true">{symbol} </span>
      {event.message}
    </li>
  );
}

// What the bot is doing right now: searching, sorting, or the job it is applying to with every step so far.
export function CurrentRun() {
  const { run, state, log, search } = useLive();
  const active = state?.activeRun;
  if (!active) return <p className="text-sm text-slate-500">No run is active.</p>;

  const notice = active.stopRequested
    ? 'Stopping after the current step…'
    : active.paused
      ? 'Paused. Nothing is clicked until you resume.'
      : null;
  const searched = run.findLast((e) => e.type === 'SEARCH_FINISHED');
  const queued = run.findLast((e) => e.type === 'QUEUE_READY');
  const start = run.findLast((e) => e.type === 'JOB_STARTED');

  if (!start) {
    const lastLine = log.findLast((line) => line.runId === active.id)?.message;
    return (
      <div className="space-y-1 text-sm" aria-live="polite">
        {queued ? (
          <p className="font-medium">{queued.message}. Applying automatically…</p>
        ) : searched ? (
          <p className="font-medium">{searched.message}. Filtering…</p>
        ) : (
          <>
            <p className="font-medium">
              Searching Naukri…{search?.runId === active.id && ` ${search.found} jobs found, ${search.added} new`}
            </p>
            {lastLine && <p className="text-slate-600">{lastLine}</p>}
          </>
        )}
        {notice && <p className="text-amber-800">{notice}</p>}
      </div>
    );
  }

  const steps = run.filter((e) => e.applicationId === start.applicationId && e.type !== 'JOB_STARTED');
  const final = steps.find((e) => e.status);
  const { position, total, nextCompany, nextTitle } = start.detail ?? {};
  return (
    <div className="space-y-3">
      <p className="text-2xl font-semibold tabular-nums" aria-live="polite">
        {String(position)} / {String(total)}
      </p>
      <div>
        <p className="font-semibold">{start.company}</p>
        <p className="text-sm text-slate-700">{start.jobTitle}</p>
      </div>
      <ol aria-label="Steps for this job" className="space-y-0.5 text-sm">
        {steps.map((event, index) => (
          <Step key={index} event={event} />
        ))}
      </ol>
      {final?.status ? (
        <p className="flex items-center gap-2 text-sm font-semibold">
          <StatusBadge status={final.status} />
        </p>
      ) : (
        <p className="text-sm text-sky-700">Applying…</p>
      )}
      {nextCompany && (
        <p className="text-xs text-slate-500">
          Next: {String(nextCompany)} · {String(nextTitle)}
        </p>
      )}
      {notice && <p className="text-sm text-amber-800">{notice}</p>}
    </div>
  );
}

// Pause, Resume and Stop for the active run; nothing when idle.
export function RunControls() {
  const { state } = useLive();
  const [error, setError] = useState<string | null>(null);
  const run = state?.activeRun;
  if (!run) return null;
  const send = (action: 'pause' | 'resume' | 'stop') => post(`/api/runs/${action}`).then(() => setError(null), (err: Error) => setError(err.message));

  return (
    <div className="flex flex-wrap items-center gap-2">
      {run.paused ? (
        <Button onClick={() => send('resume')} disabled={run.stopRequested}>
          Resume
        </Button>
      ) : (
        <Button onClick={() => send('pause')} disabled={run.stopRequested}>
          Pause
        </Button>
      )}
      <Button variant="danger" onClick={() => send('stop')} disabled={run.stopRequested}>
        {run.stopRequested ? 'Stopping…' : 'Stop'}
      </Button>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
