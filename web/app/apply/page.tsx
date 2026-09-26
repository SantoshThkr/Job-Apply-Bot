'use client';

import { OUTCOME_LABELS, type ApplicationSummary, type Outcome, type Run, type RunDetail } from '@bot/domain';
import { useEffect, useState } from 'react';
import { ApplicationDetails, ApplicationTable } from '@/components/applications';
import { CurrentRun, RunControls } from '@/components/live';
import { ScopePicker } from '@/components/scope-picker';
import { Button, ErrorText, Panel, Stat } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { useLive } from '@/lib/live';
import { scopeQuery, useScope } from '@/lib/scope';

const COUNTED: Outcome[] = ['ready', 'applying', 'applied', 'failed', 'external', 'review', 'already_applied'];

export default function ApplyPage() {
  const { state, version } = useLive();
  const { scope } = useScope();
  const { data: summary, error } = useApi<ApplicationSummary>(`/api/applications/summary?${scopeQuery(scope)}`, version);
  const [autoApply, setAutoApply] = useState<boolean | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (summary && autoApply === null) setAutoApply(summary.autoApply);
  }, [summary, autoApply]);

  const { data: latest } = useApi<Run[]>('/api/runs?kind=APPLY&limit=1', version);
  const runId = state?.activeRun?.kind === 'APPLY' ? state.activeRun.id : latest?.[0]?.id;
  const { data: run } = useApi<RunDetail>(runId ? `/api/runs/${runId}` : null, version);

  const toggleAutoApply = (on: boolean) => {
    if (on && !window.confirm('With auto apply on, the bot clicks Apply and sends real applications on Naukri. Turn it on?')) return;
    setAutoApply(on);
  };

  const start = () => {
    setStartError(null);
    setSelected(null);
    post('/api/applications/start', { ...scope, autoApply: Boolean(autoApply) }).catch((err: Error) => setStartError(err.message));
  };

  return (
    <div className="space-y-4">
      <Panel title="Which jobs">
        <ScopePicker />
      </Panel>

      <ErrorText>{error}</ErrorText>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {COUNTED.map((outcome) => (
          <Stat key={outcome} label={OUTCOME_LABELS[outcome]} value={summary?.counts[outcome] ?? '-'} />
        ))}
      </dl>
      {summary && (
        <p className="text-sm text-slate-600">
          A run works through all {summary.queued} job{summary.queued === 1 ? '' : 's'} in the queue (match {summary.minMatchScore}+, freshest
          first; failed ones are retried, and jobs that may already be sent never are).
          {summary.awaitingMatch > 0 && ` ${summary.awaitingMatch} more wait for an AI match; Search on the Jobs page scores them.`}
        </p>
      )}

      <Panel title="Application run" actions={<RunControls />}>
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" role="switch" className="mt-0.5" checked={Boolean(autoApply)} onChange={(e) => toggleAutoApply(e.target.checked)} />
            <span>
              <span className="font-medium">Auto apply</span> <span className="text-slate-500">{autoApply ? 'ON' : 'OFF'}</span>
              <span className="block text-xs text-slate-500">
                {autoApply
                  ? 'Clicks Apply and answers known questions. On Naukri that sends the application; each is marked Applied only when Naukri confirms it.'
                  : 'Opens each job and stops before Apply. Jobs end as Ready to apply.'}
              </span>
            </span>
          </label>
          <Button variant="primary" disabled={Boolean(state?.activity) || !summary?.queued} onClick={start}>
            Start{summary ? ` (${summary.queued})` : ''}
          </Button>
          <ErrorText>{startError}</ErrorText>
          {summary?.problems.length ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-amber-900">
              {summary.problems.map((problem) => (
                <li key={problem} className="whitespace-pre-line">
                  {problem}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="border-t border-slate-100 pt-3">
            <CurrentRun />
          </div>
        </div>
      </Panel>

      {run && (
        <Panel title={state?.activeRun?.id === run.id ? 'This run' : 'Last run'}>
          <p className="mb-3 text-sm text-slate-600">
            {run.attempted} of {run.stats.queued ?? run.attempted} processed · {run.outcomes.applied} applied · {run.outcomes.failed} failed ·{' '}
            {run.outcomes.review} review · {run.outcomes.external} external
            {run.stopReason && ` · stopped: ${run.stopReason}`}
          </p>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <ApplicationTable applications={run.applications} selectedId={selected} onSelect={setSelected} />
            <aside aria-label="Application details" className="rounded border border-slate-200 p-3">
              {selected ? <ApplicationDetails id={selected} /> : <p className="text-sm text-slate-500">Select a job to see each step and the exact reason.</p>}
            </aside>
          </div>
        </Panel>
      )}
    </div>
  );
}
