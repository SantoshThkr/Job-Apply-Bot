'use client';

import type { ScopeSummary, StatusResponse } from '@bot/domain';
import Link from 'next/link';
import { useState } from 'react';
import { CurrentRun, RunControls } from '@/components/live';
import { RunSummary, ScopeCounts, SettingsLine } from '@/components/summary';
import { Button, ErrorText, Panel, StatusBadge } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { useLive } from '@/lib/live';
import { scopeQuery, useSettings } from '@/lib/scope';

const SESSION_HINTS: Record<string, string> = {
  WAITING_FOR_LOGIN: 'Log in to Naukri in the Chrome window, including any OTP or CAPTCHA. This updates when your Naukri homepage opens; click Check if it does not.',
  LOGGED_OUT: 'Not logged in. Click Log in and log in yourself in the Chrome window.',
  CHALLENGE: 'Naukri is showing a security check. Complete it yourself in Chrome, then click Check. The bot never solves CAPTCHA or OTP.',
  BLOCKED: 'Naukri refused this browser (Access Denied). Wait a while before trying again.',
};

export default function DashboardPage() {
  const { version, state } = useLive();
  const { settings } = useSettings();
  const { data, error } = useApi<StatusResponse>('/api/status', version);
  const { data: summary } = useApi<ScopeSummary>(`/api/summary?${scopeQuery(settings)}`, version);
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
          <dd>{data ? `${data.ai.provider} / ${data.ai.model}` : '-'}</dd>
          <dt className="text-slate-500">Profile</dt>
          <dd>
            {data?.profileReady ? (
              <StatusBadge status="PROFILE_READY" />
            ) : (
              <Link href="/profile" className="text-sm text-sky-700 underline">
                Set up your profile
              </Link>
            )}
          </dd>
        </dl>
        {state && SESSION_HINTS[state.session] && <p className="mt-3 text-sm text-slate-700">{SESSION_HINTS[state.session]}</p>}
        <div className="mt-3">
          <ErrorText>{actionError}</ErrorText>
        </div>
      </Panel>

      <div className="space-y-2">
        <SettingsLine />
        <ScopeCounts summary={summary} foundLabel="Fresh jobs" />
      </div>

      <Panel title="Current run" actions={<RunControls />}>
        {state?.activeRun || !data?.lastRun ? <CurrentRun /> : <RunSummary run={data.lastRun} />}
      </Panel>
    </div>
  );
}
