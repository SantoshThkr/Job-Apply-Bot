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

// What the bot is doing right now: the job it is on and every step so far, or that nothing is running.
export function CurrentRun() {
  const { run, state, analysis, log } = useLive();
  const active = state?.activeRun;
  if (!active) return <p className="text-sm text-slate-500">No active application run.</p>;

  if (active.kind !== 'APPLY') {
    const lastLine = log.findLast((line) => line.runId === active.id)?.message;
    return (
      <p className="text-sm" aria-live="polite">
        {analysis && analysis.runId === active.id
          ? `Matching ${analysis.done} / ${analysis.total}: ${analysis.jobTitle} · ${analysis.company}`
          : (lastLine ?? 'Searching Naukri…')}
      </p>
    );
  }

  const start = run.findLast((e) => e.type === 'JOB_STARTED');
  const notice = active.stopRequested
    ? 'Stopping after the current step…'
    : active.paused
      ? 'Paused. Nothing is clicked until you resume.'
      : null;
  if (!start) {
    return (
      <div className="space-y-1 text-sm">
        <p>Checking the Naukri session and building the queue…</p>
        {notice && <p className="text-amber-800">{notice}</p>}
      </div>
    );
  }

  const steps = run.filter((e) => e.applicationId === start.applicationId && e.type !== 'JOB_STARTED');
  const final = steps.find((e) => e.status);
  const { position, total } = start.detail ?? {};
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
          Status <StatusBadge status={final.status} />
        </p>
      ) : (
        <p className="text-sm text-sky-700">Working…</p>
      )}
      {notice && <p className="text-sm text-amber-800">{notice}</p>}
    </div>
  );
}

// Pause, Resume and Stop for whatever run is active; nothing when idle.
export function RunControls() {
  const { state } = useLive();
  const [error, setError] = useState<string | null>(null);
  const run = state?.activeRun;
  if (!run) return null;
  const send = (action: 'pause' | 'resume' | 'stop') => post(`/api/runs/${action}`).then(() => setError(null), (err: Error) => setError(err.message));

  return (
    <div className="flex flex-wrap items-center gap-2">
      {run.kind === 'APPLY' &&
        (run.paused ? (
          <Button onClick={() => send('resume')} disabled={run.stopRequested}>
            Resume
          </Button>
        ) : (
          <Button onClick={() => send('pause')} disabled={run.stopRequested}>
            Pause
          </Button>
        ))}
      <Button variant="danger" onClick={() => send('stop')} disabled={run.stopRequested}>
        {run.stopRequested ? 'Stopping…' : 'Stop'}
      </Button>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
