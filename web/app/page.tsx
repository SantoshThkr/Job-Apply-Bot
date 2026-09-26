'use client';

import type { StatusResponse } from '@bot/domain';
import { useState } from 'react';
import { CurrentRun, RunControls } from '@/components/live';
import { Button, ErrorText, Panel, Stat, StatusBadge } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { useLive } from '@/lib/live';

const SESSION_HINTS: Record<string, string> = {
  WAITING_FOR_LOGIN: 'Log in to Naukri in the Chrome window, including any OTP or CAPTCHA. This updates when your Naukri homepage opens; click Check if it does not.',
  LOGGED_OUT: 'Not logged in. Click Log in and log in yourself in the Chrome window.',
  CHALLENGE: 'Naukri is showing a security check. Complete it yourself in Chrome, then click Check. The bot never solves CAPTCHA or OTP.',
  BLOCKED: 'Naukri refused this browser (Access Denied). Wait a while before trying again.',
};

export default function DashboardPage() {
  const { version, state } = useLive();
  const { data, error } = useApi<StatusResponse>('/api/status', version);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = pending || Boolean(state?.activity);

  const act = (path: string) => {
    setPending(true);
    setActionError(null);
    post(path)
      .catch((err: Error) => setActionError(err.message))
      .finally(() => setPending(false));
  };

  return (
    <div className="space-y-4">
      <ErrorText>{error}</ErrorText>
      <Panel title="Status">
        <dl className="grid grid-cols-[5rem_1fr] items-center gap-x-4 gap-y-2 text-sm">
          <dt className="text-slate-500">Naukri</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {state ? <StatusBadge status={state.session} /> : '-'}
            <Button disabled={busy} onClick={() => act('/api/session/login')}>
              Log in
            </Button>
            {/* Stays enabled during login: it tells the waiting login to look again. */}
            <Button disabled={pending || (busy && state?.activity !== 'LOGIN')} onClick={() => act('/api/session/check')}>
              Check
            </Button>
          </dd>
          <dt className="text-slate-500">Browser</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {state ? <StatusBadge status={`BROWSER_${state.browser}`} /> : '-'}
            {state?.browser === 'RUNNING' ? (
              <Button disabled={pending || Boolean(state.activeRun)} onClick={() => act('/api/browser/stop')}>
                Close
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => act('/api/browser/start')}>
                Open
              </Button>
            )}
          </dd>
          <dt className="text-slate-500">AI</dt>
          <dd className="flex items-center gap-2">
            <span aria-hidden="true" className="text-emerald-600">
              ●
            </span>
            {data ? `${data.ai.provider} / ${data.ai.model}` : '-'}
          </dd>
        </dl>
        {state && SESSION_HINTS[state.session] && <p className="mt-3 text-sm text-slate-700">{SESSION_HINTS[state.session]}</p>}
        <div className="mt-3">
          <ErrorText>{actionError}</ErrorText>
        </div>
      </Panel>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Jobs found" value={data?.counts.jobsFound ?? '-'} />
        <Stat label="Fresh jobs (24h)" value={data?.counts.freshJobs ?? '-'} />
        <Stat label="Applied" value={data?.counts.applied ?? '-'} />
        <Stat label="Failed" value={data?.counts.failed ?? '-'} />
      </dl>

      <Panel title="Current run" actions={<RunControls />}>
        <CurrentRun />
      </Panel>
    </div>
  );
}
