'use client';

import type { JobCategory, JobPage } from '@bot/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api';
import { posted } from '@/lib/format';
import { useLive } from '@/lib/live';
import { scopeQuery, useScope } from '@/lib/scope';
import { Button, ErrorText, StatusBadge } from './ui';

const STATUS_FILTERS: [JobCategory | 'all', string][] = [
  ['all', 'All'],
  ['ready', 'Ready to apply'],
  ['applied', 'Applied'],
  ['failed', 'Failed'],
  ['external', 'External'],
  ['review', 'Review'],
  ['new', 'New (no match yet)'],
];
const PAGE_SIZE = 100;

export function JobsTable() {
  const router = useRouter();
  const { version } = useLive();
  const { scope } = useScope();
  const [status, setStatus] = useState<JobCategory | 'all'>('all');
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [scope, status]);

  const query = `${scopeQuery(scope)}&status=${status}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
  const { data, error } = useApi<JobPage>(`/api/jobs?${query}`, version);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">{data ? `${data.total} job${data.total === 1 ? '' : 's'}` : 'Loading…'}</p>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as JobCategory | 'all')} className="rounded border border-slate-300 bg-white px-2 py-1">
            {STATUS_FILTERS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Jobs, the ones still to act on first, newest first</caption>
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr>
              <th scope="col" className="py-2 pr-3 font-medium">Company</th>
              <th scope="col" className="py-2 pr-3 font-medium">Job</th>
              <th scope="col" className="py-2 pr-3 font-medium">Location</th>
              <th scope="col" className="py-2 pr-3 font-medium">Posted</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Match</th>
              <th scope="col" className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {data?.jobs.map((job) => (
              <tr key={job.id} onClick={() => router.push(`/jobs/${job.id}`)} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50">
                <td className="py-1.5 pr-3 font-medium">{job.company}</td>
                <td className="py-1.5 pr-3">
                  <Link href={`/jobs/${job.id}`} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                    {job.title}
                  </Link>
                </td>
                <td className="max-w-48 truncate py-1.5 pr-3 text-slate-600" title={job.location ?? undefined}>
                  {job.location ?? '-'}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-3 text-slate-600">{posted(job.postedAt)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{job.score ?? '-'}</td>
                <td className="py-1.5">
                  <StatusBadge status={job.category} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.jobs.length && <p className="py-6 text-center text-sm text-slate-500">No jobs here yet. Search Naukri above.</p>}
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm text-slate-600">
          <Button disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span>
            Page {page + 1} of {pages}
          </span>
          <Button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
