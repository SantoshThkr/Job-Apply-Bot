'use client';

import type { RunDetail } from '@bot/domain';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApplicationDetails, ApplicationTable } from '@/components/applications';
import { RunControls } from '@/components/live';
import { ErrorText, Panel, StatusBadge } from '@/components/ui';
import { useApi } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useLive } from '@/lib/live';

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const { version, state } = useLive();
  const { data: run, error } = useApi<RunDetail>(`/api/runs/${id}`, version);
  const [selected, setSelected] = useState<number | null>(null);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!run) return <p className="text-sm text-slate-500">Loading…</p>;
  const active = state?.activeRun?.id === run.id;

  return (
    <div className="space-y-4">
      <Link href="/history" className="text-sm text-sky-700 underline">
        ← History
      </Link>
      <Panel title={`Run ${dateTime(run.startedAt)}`} actions={active ? <RunControls /> : <StatusBadge status={run.status} />}>
        <p className="text-sm text-slate-700">
          {run.attempted} jobs · {run.outcomes.applied} applied · {run.outcomes.failed} failed · {run.outcomes.review} review · {run.outcomes.external}{' '}
          external · {run.outcomes.ready} ready to apply · {run.outcomes.already_applied} already applied
        </p>
        {run.stopReason && (
          <p className="mt-2 text-sm text-amber-900">
            {run.status === 'FAILED' ? 'Failed' : 'Stopped'}: {run.stopReason}
          </p>
        )}
        <p className="mt-1 font-mono text-xs text-slate-500">{run.id}</p>
      </Panel>
      <Panel title="Results">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <ApplicationTable applications={run.applications} selectedId={selected} onSelect={setSelected} />
          <aside aria-label="Application details" className="rounded border border-slate-200 p-3">
            {selected ? <ApplicationDetails id={selected} /> : <p className="text-sm text-slate-500">Select a job to see each step and the exact reason.</p>}
          </aside>
        </div>
      </Panel>
    </div>
  );
}
