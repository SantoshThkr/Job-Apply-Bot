'use client';

import type { JobProfileSummary, Run, ScopeSummary } from '@bot/domain';
import Link from 'next/link';
import { useApi } from '@/lib/api';
import { experienceText, freshnessText } from '@/lib/format';
import { useSettings, type RunSettings } from '@/lib/scope';
import { Stat } from './ui';

type SettingsLike = Pick<RunSettings, 'profiles' | 'locations' | 'freshness' | 'from' | 'to' | 'experienceYears' | 'toleranceMonths'>;

export function settingsText(settings: SettingsLike, profiles: JobProfileSummary[] = []): string {
  const names = settings.profiles.map((id) => profiles.find((p) => p.id === id)?.name ?? id);
  return [
    names.join(', ') || 'All job profiles',
    settings.locations.join(', ') || 'Anywhere',
    freshnessText(settings),
    experienceText(settings.experienceYears, settings.toleranceMonths),
  ].join(' · ');
}

// A run's settings as it recorded them; older runs may lack some.
function runSettings(run: Run): SettingsLike | null {
  const s = run.settings;
  if (typeof s.freshness !== 'string') return null;
  return {
    profiles: Array.isArray(s.profiles) ? s.profiles : [],
    locations: Array.isArray(s.locations) ? s.locations : [],
    freshness: s.freshness as RunSettings['freshness'],
    from: typeof s.from === 'string' ? s.from : null,
    to: typeof s.to === 'string' ? s.to : null,
    experienceYears: typeof s.experienceYears === 'number' ? s.experienceYears : null,
    toleranceMonths: typeof s.toleranceMonths === 'number' ? s.toleranceMonths : 0,
  };
}

// The settings the next run uses, in one line, with where to change them.
export function SettingsLine() {
  const { settings } = useSettings();
  const { data: profiles } = useApi<JobProfileSummary[]>('/api/profiles');
  return (
    <p className="text-sm text-slate-600">
      {settingsText(settings, profiles)} ·{' '}
      <Link href="/apply" className="text-sky-700 underline">
        change
      </Link>
    </p>
  );
}

export function ScopeCounts({ summary, foundLabel = 'Found' }: { summary: ScopeSummary | undefined; foundLabel?: string }) {
  const value = (n: number | undefined) => n ?? '-';
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <Stat label={foundLabel} value={value(summary?.found)} />
      <Stat label="Eligible" value={value(summary?.eligible)} />
      <Stat label="Applied" value={value(summary?.counts.applied)} />
      <Stat label="Review" value={value(summary?.counts.review)} />
      <Stat label="Failed" value={value(summary?.counts.failed)} />
      <Stat label="External" value={value(summary?.counts.external)} />
    </dl>
  );
}

const ENDINGS: Record<Run['status'], string> = {
  RUNNING: 'Running',
  PAUSED: 'Paused',
  COMPLETED: 'Run complete',
  STOPPED: 'Stopped',
  FAILED: 'Run failed',
};

// "Run complete: 31 applied · 4 review · 2 failed · 5 external", with the search funnel when there was one.
export function RunSummary({ run }: { run: Run }) {
  const { data: profiles } = useApi<JobProfileSummary[]>('/api/profiles');
  const { found, relevant, eligible, queued } = run.stats;
  const { applied, review, failed, external, ready, already_applied: already } = run.outcomes;
  const settings = runSettings(run);
  return (
    <div className="space-y-1 text-sm">
      {settings && (
        <p className="text-slate-600">
          {settingsText(settings, profiles)} · Auto apply {run.settings.autoApply ? 'ON' : 'OFF'}
        </p>
      )}
      <p>
        <span className="font-semibold">{ENDINGS[run.status]}:</span> {run.attempted} of {queued ?? run.attempted} processed · {applied} applied · {review} review ·{' '}
        {failed} failed · {external} external{ready ? ` · ${ready} ready to apply` : ''}
        {already ? ` · ${already} already applied` : ''}
      </p>
      {found !== undefined && (
        <p className="text-slate-600">
          Search: {found} found · {relevant ?? '-'} relevant · {eligible ?? '-'} eligible
        </p>
      )}
      {run.stopReason && <p className="text-amber-900">{run.stopReason}</p>}
    </div>
  );
}
