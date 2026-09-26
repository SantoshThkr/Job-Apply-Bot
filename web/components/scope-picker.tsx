'use client';

import { FRESHNESS, type JobProfileSummary } from '@bot/domain';
import { useApi } from '@/lib/api';
import { FRESHNESS_LABELS } from '@/lib/format';
import { useSettings } from '@/lib/scope';
import { ErrorText } from './ui';

const COMMON_LOCATIONS = ['Remote', 'Bangalore', 'Hyderabad', 'Pune', 'Chennai', 'Mumbai', 'Delhi NCR', 'Noida', 'Gurugram', 'Kolkata', 'Ahmedabad'];
const TOLERANCES = [0, 3, 6, 9, 12];

const chip = (on: boolean) =>
  `rounded-full px-3 py-1 text-sm ring-1 ring-inset ${on ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'}`;
const input = 'rounded border border-slate-300 bg-white px-2 py-1 text-sm';

const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((i) => i !== item) : [...list, item]);

function Chips({ legend, note, options, chosen, onToggle }: { legend: string; note?: string; options: [string, string][]; chosen: string[]; onToggle: (id: string) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-slate-700">
        {legend} {note && <span className="font-normal text-slate-500">{note}</span>}
      </legend>
      <div className="flex flex-wrap gap-2">
        {options.map(([id, text]) => (
          <button key={id} type="button" aria-pressed={chosen.includes(id)} className={chip(chosen.includes(id))} onClick={() => onToggle(id)}>
            {text}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

// What the next run searches for and applies to.
export function SettingsForm() {
  const { settings, setSettings, profile } = useSettings();
  const { data: profiles, error } = useApi<JobProfileSummary[]>('/api/profiles');
  const locations = [...new Set([...(profile?.defaults.locations ?? []), ...COMMON_LOCATIONS, ...settings.locations])];

  return (
    <div className="space-y-4">
      <ErrorText>{error}</ErrorText>
      <Chips
        legend="Job profiles"
        note={settings.profiles.length ? undefined : '(all)'}
        options={profiles?.map((p) => [p.id, p.name]) ?? []}
        chosen={settings.profiles}
        onToggle={(id) => setSettings({ profiles: toggle(settings.profiles, id) })}
      />
      <Chips
        legend="Locations"
        note={settings.locations.length ? '(remote jobs always count)' : '(anywhere)'}
        options={locations.map((l) => [l, l])}
        chosen={settings.locations}
        onToggle={(l) => setSettings({ locations: toggle(settings.locations, l) })}
      />
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-slate-700">Posted</legend>
        <div className="flex flex-wrap items-center gap-2">
          {FRESHNESS.map((freshness) => (
            <button key={freshness} type="button" aria-pressed={settings.freshness === freshness} className={chip(settings.freshness === freshness)} onClick={() => setSettings({ freshness })}>
              {FRESHNESS_LABELS[freshness]}
            </button>
          ))}
        </div>
        {settings.freshness === 'custom' && (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              From
              <input type="date" className={input} value={settings.from ?? ''} max={settings.to ?? undefined} onChange={(e) => setSettings({ from: e.target.value || null })} />
            </label>
            <label className="flex items-center gap-2">
              To
              <input type="date" className={input} value={settings.to ?? ''} min={settings.from ?? undefined} onChange={(e) => setSettings({ to: e.target.value || null })} />
            </label>
          </div>
        )}
      </fieldset>
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="font-medium text-slate-700">Experience (years)</span>
          <input
            type="number"
            min={0}
            max={60}
            step={0.5}
            className={`${input} w-24`}
            value={settings.experienceYears ?? ''}
            onChange={(e) => setSettings({ experienceYears: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium text-slate-700">Tolerance</span>
          <select className={input} value={settings.toleranceMonths} onChange={(e) => setSettings({ toleranceMonths: Number(e.target.value) })}>
            {TOLERANCES.map((months) => (
              <option key={months} value={months}>
                {months ? `${months} months` : 'None'}
              </option>
            ))}
          </select>
        </label>
        <p className="pb-1 text-xs text-slate-500">
          {settings.experienceYears === null
            ? 'Experience is not checked.'
            : `Jobs asking for more than ${settings.experienceYears + settings.toleranceMonths / 12} years are not applied to.`}
        </p>
      </div>
    </div>
  );
}
