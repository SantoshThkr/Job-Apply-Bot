'use client';

import type { JobDetail, JobProfileSummary } from '@bot/domain';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApplicationDetails, ApplicationTable } from '@/components/applications';
import { ErrorText, Panel, StatusBadge } from '@/components/ui';
import { useApi } from '@/lib/api';
import { dateTime, posted } from '@/lib/format';
import { useLive } from '@/lib/live';
import { scopeQuery, useSettings } from '@/lib/scope';

function Skills({ title, skills }: { title: string; skills: string[] }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</dt>
      <dd className="mt-1 text-sm">{skills.length ? skills.join(', ') : <span className="text-slate-400">None</span>}</dd>
    </div>
  );
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const { version } = useLive();
  const { settings } = useSettings();
  const { data: job, error } = useApi<JobDetail>(`/api/jobs/${id}?${scopeQuery(settings)}`, version);
  const { data: profiles } = useApi<JobProfileSummary[]>('/api/profiles');
  const [selected, setSelected] = useState<number | null>(null);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!job) return <p className="text-sm text-slate-500">Loading…</p>;
  const analysis = job.analysis;
  const profileNames = job.profiles.map((p) => profiles?.find((profile) => profile.id === p)?.name ?? p);

  return (
    <div className="space-y-4">
      <Link href="/jobs" className="text-sm text-sky-700 underline">
        ← Jobs
      </Link>
      <Panel title={`${job.title} · ${job.company}`} actions={<StatusBadge status={job.category} />}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
          <dt className="text-slate-500">Location</dt>
          <dd>{[job.location, job.workMode].filter(Boolean).join(' · ') || '-'}</dd>
          <dt className="text-slate-500">Posted</dt>
          <dd>{posted(job.postedAt)}</dd>
          <dt className="text-slate-500">Match</dt>
          <dd className="tabular-nums">{job.score ?? '-'}</dd>
          <dt className="text-slate-500">Profiles</dt>
          <dd>{profileNames.join(', ') || '-'}</dd>
          <dt className="text-slate-500">Experience asked</dt>
          <dd>
            {job.experience ?? '-'}
            {job.ineligibleReason && <span className="ml-2 text-xs text-slate-500">Not eligible: {job.ineligibleReason}</span>}
          </dd>
          <dt className="text-slate-500">Applies on</dt>
          <dd>
            {job.externalApply ? (
              job.externalUrl ? (
                <a href={job.externalUrl} target="_blank" rel="noreferrer" className="text-sky-700 underline">
                  Company site
                </a>
              ) : (
                'Company site'
              )
            ) : job.externalApply === false ? (
              'Naukri'
            ) : (
              '-'
            )}
          </dd>
          <dt className="text-slate-500">Job</dt>
          <dd>
            <a href={job.url} target="_blank" rel="noreferrer" className="text-sky-700 underline">
              Open on Naukri
            </a>
          </dd>
          <dt className="text-slate-500">Found</dt>
          <dd>{dateTime(job.discoveredAt)}</dd>
        </dl>
        {job.filterReason && <p className="mt-3 text-sm text-slate-700">Not matched: {job.filterReason}</p>}
        {job.analysisError && <p className="mt-3 text-sm text-red-700">AI match failed: {job.analysisError}</p>}
      </Panel>

      {analysis && (
        <Panel title={`AI match ${analysis.score}`} actions={<span className="text-xs text-slate-500">{analysis.provider} · {analysis.model}</span>}>
          <p className="text-sm">{analysis.reason}</p>
          {analysis.holdReason && <p className="mt-2 text-sm text-amber-800">Held for review: {analysis.holdReason}</p>}
          <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Skills title="Required" skills={analysis.requiredSkills} />
            <Skills title="Matched" skills={analysis.matchedSkills} />
            <Skills title="Missing" skills={analysis.missingSkills} />
            <Skills title="Preferred" skills={analysis.preferredSkills} />
            <Skills title="Red flags" skills={analysis.redFlags} />
          </dl>
        </Panel>
      )}

      <Panel title="Applications">
        <ApplicationTable applications={job.applications} selectedId={selected} onSelect={setSelected} />
        {selected && (
          <div className="mt-4 rounded border border-slate-200 p-3">
            <ApplicationDetails id={selected} />
          </div>
        )}
      </Panel>

      {job.description && (
        <Panel title="Description">
          <p className="whitespace-pre-line text-sm text-slate-700">{job.description}</p>
        </Panel>
      )}
    </div>
  );
}
