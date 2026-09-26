'use client';

import { FRESHNESS, type JobProfileSummary } from '@bot/domain';
import { useApi } from '@/lib/api';
import { FRESHNESS_LABELS } from '@/lib/format';
import { useScope } from '@/lib/scope';
import { ErrorText } from './ui';

const chip = (on: boolean) =>
  `rounded-full px-3 py-1 text-sm ring-1 ring-inset ${on ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'}`;

// Which job profiles and how fresh. No profile ticked means all of them.
export function ScopePicker() {
  const { scope, setScope } = useScope();
  const { data: profiles, error } = useApi<JobProfileSummary[]>('/api/profiles');

  const toggle = (id: string) =>
    setScope({ ...scope, profiles: scope.profiles.includes(id) ? scope.profiles.filter((p) => p !== id) : [...scope.profiles, id] });

  return (
    <div className="space-y-3">
      <ErrorText>{error}</ErrorText>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-slate-700">
          Profiles <span className="font-normal text-slate-500">{scope.profiles.length ? '' : '(all)'}</span>
        </legend>
        <div className="flex flex-wrap gap-2">
          {profiles?.map((profile) => (
            <button key={profile.id} type="button" aria-pressed={scope.profiles.includes(profile.id)} className={chip(scope.profiles.includes(profile.id))} onClick={() => toggle(profile.id)}>
              {profile.name}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-slate-700">Posted</legend>
        <div className="flex flex-wrap gap-2">
          {FRESHNESS.map((freshness) => (
            <button key={freshness} type="button" aria-pressed={scope.freshness === freshness} className={chip(scope.freshness === freshness)} onClick={() => setScope({ ...scope, freshness })}>
              {FRESHNESS_LABELS[freshness]}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
