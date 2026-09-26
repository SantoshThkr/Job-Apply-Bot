'use client';

import type { Run } from '@bot/domain';
import { useState } from 'react';
import { JobsTable } from '@/components/jobs-table';
import { CurrentRun, RunControls } from '@/components/live';
import { ScopePicker } from '@/components/scope-picker';
import { Button, ErrorText, Panel } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useLive } from '@/lib/live';
import { useScope } from '@/lib/scope';

function LastSearch() {
  const { version } = useLive();
  const { data } = useApi<Run[]>('/api/runs?kind=SEARCH&limit=1', version);
  const run = data?.[0];
  if (!run) return null;
  const { seen = 0, added = 0, succeeded = 0 } = run.stats;
  return (
    <p className="text-sm text-slate-600">
      Last search {dateTime(run.startedAt)}: {seen} found, {added} new, {succeeded} matched by AI
      {run.status !== 'COMPLETED' && ` (${run.status.toLowerCase()}${run.stopReason ? `: ${run.stopReason}` : ''})`}
    </p>
  );
}

export default function JobsPage() {
  const { state } = useLive();
  const { scope } = useScope();
  const [error, setError] = useState<string | null>(null);
  const searching = state?.activeRun?.kind === 'SEARCH';

  const search = () => {
    setError(null);
    post('/api/jobs/search', scope).catch((err: Error) => setError(err.message));
  };

  return (
    <div className="space-y-4">
      <Panel title="Find jobs">
        <div className="space-y-4">
          <ScopePicker />
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={Boolean(state?.activity)} onClick={search}>
              Search
            </Button>
            {searching && <RunControls />}
          </div>
          <p className="text-xs text-slate-500">Searches Naukri for the chosen profiles, reads each new job and scores it with the local AI. Experience is never a filter.</p>
          <ErrorText>{error}</ErrorText>
          {searching ? <CurrentRun /> : <LastSearch />}
        </div>
      </Panel>
      <Panel title="Jobs">
        <JobsTable />
      </Panel>
    </div>
  );
}
