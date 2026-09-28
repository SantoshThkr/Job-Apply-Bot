'use client';

import type { Run, RunDetail, ScopeSummary } from '@bot/domain';
import Link from 'next/link';
import { useState } from 'react';
import { ApplicationDetails, ApplicationTable } from '@/components/applications';
import { CurrentRun, RunControls } from '@/components/live';
import { SettingsForm } from '@/components/scope-picker';
import { RunSummary, ScopeCounts } from '@/components/summary';
import { Button, ErrorText, Panel } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { useLive } from '@/lib/live';
import { scopeOf, scopeQuery, useSettings } from '@/lib/scope';

// Only the latest attempts; the full list is on the run's History page.
const SHOWN = 50;

export default function ApplyPage() {
  const { state, version } = useLive();
  const { settings, setSettings, profile } = useSettings();
  const { data: summary, error } = useApi<ScopeSummary>(`/api/summary?${scopeQuery(settings)}`, version);
  const { data: latest } = useApi<Run[]>('/api/runs?kind=APPLY&limit=1', version);
  const active = state?.activeRun;
  const runId = active?.id ?? latest?.[0]?.id;
  const { data: run } = useApi<RunDetail>(runId ? `/api/runs/${runId}?limit=${SHOWN}` : null, version);
  const [startError, setStartError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const start = () => {
    setStartError(null);
    setSelected(null);
    post('/api/runs/start', { scope: scopeOf(settings), autoApply: settings.autoApply }).catch((err: Error) => setStartError(err.message));
  };

  const needsDates = settings.freshness === 'custom' && !settings.from;
  return (
    <div className="space-y-4">
      <Panel title="Auto apply">
        <div className="space-y-4">
          <SettingsForm />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" role="switch" className="mt-0.5" checked={settings.autoApply} onChange={(e) => setSettings({ autoApply: e.target.checked })} />
            <span>
              <span className="font-medium">Auto apply</span>{' '}
              <span className={settings.autoApply ? 'font-semibold text-emerald-700' : 'text-slate-500'}>{settings.autoApply ? 'ON' : 'OFF'}</span>
              <span className="block text-xs text-slate-500">
                {settings.autoApply
                  ? 'Clicks Apply and answers known questions. On Naukri that sends the application; a job is Applied only when Naukri confirms it.'
                  : 'Searches and checks every eligible job, then stops before Apply. Jobs end as Ready to apply.'}
              </span>
            </span>
          </label>
          <Button variant="primary" className="px-5 py-2" disabled={Boolean(state?.activity) || !profile?.ready || needsDates} onClick={start}>
            {settings.autoApply ? 'Start auto apply' : 'Start (check only)'}
          </Button>
          {profile && !profile.ready && (
            <p className="text-sm text-amber-900">
              Set up your{' '}
              <Link href="/profile" className="underline">
                profile
              </Link>{' '}
              first.
            </p>
          )}
          {needsDates && <p className="text-sm text-amber-900">Pick a start date for the custom range.</p>}
          <ErrorText>{startError ?? error}</ErrorText>
          {summary?.problems.length ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-amber-900">
              {summary.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </Panel>

      <ScopeCounts summary={summary} />
      {summary && (
        <p className="text-sm text-slate-600">
          {summary.queued} job{summary.queued === 1 ? '' : 's'} to apply to now, freshest first. A run searches Naukri first, so new jobs join the queue.
          {summary.counts.not_eligible > 0 && ` ${summary.counts.not_eligible} not eligible (experience or a low AI match).`}
        </p>
      )}

      <Panel title="Current run" actions={<RunControls />}>
        <CurrentRun />
      </Panel>

      {run && (
        <Panel title={active?.id === run.id ? 'This run' : 'Last run'}>
          <RunSummary run={run} />
          <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-2">
              <ApplicationTable applications={run.applications} selectedId={selected} onSelect={setSelected} />
              {run.attempted > SHOWN && (
                <Link href={`/history/${run.id}`} className="text-sm text-sky-700 underline">
                  All {run.attempted} jobs in this run
                </Link>
              )}
            </div>
            <aside aria-label="Application details" className="rounded border border-slate-200 p-3">
              {selected ? <ApplicationDetails id={selected} /> : <p className="text-sm text-slate-500">Select a job to see each step and the exact reason.</p>}
            </aside>
          </div>
        </Panel>
      )}
    </div>
  );
}
