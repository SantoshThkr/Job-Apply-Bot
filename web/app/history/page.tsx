'use client';

import type { Run } from '@bot/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ErrorText, Panel, StatusBadge } from '@/components/ui';
import { useApi } from '@/lib/api';
import { dateTime, freshnessText } from '@/lib/format';
import { useLive } from '@/lib/live';

const searched = (run: Run) => {
  const { freshness, from, to, locations } = run.settings;
  if (typeof freshness !== 'string') return '-';
  const where = Array.isArray(locations) && locations.length ? ` · ${locations.join(', ')}` : '';
  return `${freshnessText({ freshness: freshness as Parameters<typeof freshnessText>[0]['freshness'], from: from as string | null, to: to as string | null })}${where}`;
};

export default function HistoryPage() {
  const router = useRouter();
  const { version } = useLive();
  const { data: runs, error } = useApi<Run[]>('/api/runs?kind=APPLY', version);

  return (
    <Panel title="Runs">
      <ErrorText>{error}</ErrorText>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Auto apply runs, newest first</caption>
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr>
              <th scope="col" className="py-2 pr-3 font-medium">Started</th>
              <th scope="col" className="py-2 pr-3 font-medium">Jobs</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Eligible</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Applied</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Review</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Failed</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">External</th>
              <th scope="col" className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {runs?.map((run) => (
              <tr key={run.id} onClick={() => router.push(`/history/${run.id}`)} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap py-1.5 pr-3">
                  <Link href={`/history/${run.id}`} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                    {dateTime(run.startedAt)}
                  </Link>
                </td>
                <td className="py-1.5 pr-3 text-slate-600">{searched(run)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{run.stats.eligible ?? run.stats.queued ?? '-'}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{run.outcomes.applied}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{run.outcomes.review}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{run.outcomes.failed}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{run.outcomes.external}</td>
                <td className="py-1.5">
                  <StatusBadge status={run.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs && !runs.length && <p className="py-6 text-center text-sm text-slate-500">No runs yet.</p>}
      </div>
    </Panel>
  );
}
