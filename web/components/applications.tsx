'use client';

import { domainOf, type ApplicationDetail, type ApplicationRow } from '@bot/domain';
import { useApi } from '@/lib/api';
import { label, time } from '@/lib/format';
import { useLive } from '@/lib/live';
import { ErrorText, Flag, StatusBadge } from './ui';

export function ApplicationTable({
  applications,
  selectedId,
  onSelect,
}: {
  applications: ApplicationRow[];
  selectedId?: number | null;
  onSelect?: (id: number) => void;
}) {
  if (!applications.length) return <p className="text-sm text-slate-500">No jobs attempted in this run.</p>;
  const rows = [...applications].sort((a, b) => a.id - b.id);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Result for each job in the run. Select a row for its steps.</caption>
        <thead className="border-b border-slate-200 text-xs text-slate-500">
          <tr>
            <th scope="col" className="py-2 pr-3 font-medium">Company</th>
            <th scope="col" className="py-2 pr-3 font-medium">Job</th>
            <th scope="col" className="py-2 pr-3 font-medium">Status</th>
            <th scope="col" className="py-2 pr-3 font-medium">Reason</th>
            <th scope="col" className="py-2 font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr
              key={a.id}
              onClick={() => onSelect?.(a.id)}
              className={`border-b border-slate-100 align-top ${onSelect ? 'cursor-pointer hover:bg-slate-50' : ''} ${selectedId === a.id ? 'bg-sky-50' : ''}`}
            >
              <td className="py-1.5 pr-3 font-medium">
                {onSelect ? (
                  <button type="button" className="text-left underline-offset-2 hover:underline" aria-pressed={selectedId === a.id} onClick={() => onSelect(a.id)}>
                    {a.company}
                  </button>
                ) : (
                  a.company
                )}
              </td>
              <td className="min-w-44 py-1.5 pr-3">{a.jobTitle}</td>
              <td className="py-1.5 pr-3">
                <StatusBadge status={a.outcome} />
              </td>
              <td className="max-w-72 truncate py-1.5 pr-3 text-xs text-slate-600" title={a.failureReason ?? undefined}>
                {a.failureReason ?? '-'}
              </td>
              <td className="py-1.5 tabular-nums text-slate-600">{time(a.completedAt ?? a.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// One attempt: what the bot saw and did, in order, with the exact reason it ended how it did.
export function ApplicationDetails({ id }: { id: number }) {
  const { version } = useLive();
  const { data: a, error } = useApi<ApplicationDetail>(`/api/applications/${id}`, version);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!a) return <p className="text-sm text-slate-500">Loading…</p>;

  const domain = domainOf(a.externalUrl);
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h3 className="text-base font-semibold">{a.company}</h3>
        <p>{a.jobTitle}</p>
        <a href={a.url} target="_blank" rel="noreferrer" className="text-xs text-sky-700 underline">
          Open on Naukri
        </a>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-slate-500">Status</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <StatusBadge status={a.outcome} />
          <span className="font-mono text-xs text-slate-500">{a.status}</span>
        </dd>
        {a.failureReason && (
          <>
            <dt className="text-slate-500">Reason</dt>
            <dd>
              {a.failureReason}
              {a.failureCode && <span className="ml-1 font-mono text-xs text-slate-500">({a.failureCode})</span>}
            </dd>
          </>
        )}
        {a.question && (
          <>
            <dt className="text-slate-500">Question</dt>
            <dd>“{a.question}”</dd>
          </>
        )}
        {a.externalUrl && (
          <>
            <dt className="text-slate-500">Company site</dt>
            <dd>
              <a href={a.externalUrl} target="_blank" rel="noreferrer" className="text-sky-700 underline">
                {domain}
              </a>{' '}
              <span className="text-xs text-slate-500">(not visited by the bot)</span>
            </dd>
          </>
        )}
        <dt className="text-slate-500">Steps</dt>
        <dd className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {(
            [
              ['Apply button found', a.applyButtonFound],
              ['Apply clicked', a.applyClicked],
              ['Form opened', a.formOpened],
              ['Form filled', a.formFilled],
              ['Submitted', a.submitClicked],
              ['Confirmed by Naukri', a.successConfirmed],
            ] as const
          ).map(([name, on]) => (
            <span key={name}>
              <Flag on={on} name={name} /> {name}
            </span>
          ))}
        </dd>
      </dl>
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Timeline</h4>
        <ol className="space-y-2 border-l border-slate-200 pl-4">
          {a.events.map((event) => (
            <li key={event.id}>
              <p className="font-mono text-xs text-slate-500">
                {time(event.createdAt)} · {label(event.type)}
              </p>
              <p>{event.message}</p>
              {Array.isArray(event.detail?.options) && event.detail.options.length > 0 && (
                <p className="text-xs text-slate-500">Options: {event.detail.options.join(' | ')}</p>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
