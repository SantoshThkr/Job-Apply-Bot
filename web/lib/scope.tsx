'use client';

import { FRESHNESS, type JobScope, type ProfileResponse } from '@bot/domain';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useApi } from './api';

const KEY = 'job-bot:settings';

export interface RunSettings extends Required<JobScope> {
  autoApply: boolean;
}

const DEFAULT: RunSettings = {
  profiles: [],
  locations: [],
  freshness: '24h',
  from: null,
  to: null,
  experienceYears: null,
  toleranceMonths: 6,
  autoApply: false,
};

interface Settings {
  settings: RunSettings;
  setSettings: (patch: Partial<RunSettings>) => void;
  profile: ProfileResponse | undefined;
  reloadProfile: () => void;
}

const SettingsContext = createContext<Settings>({ settings: DEFAULT, setSettings: () => {}, profile: undefined, reloadProfile: () => {} });

function saved(): Partial<RunSettings> | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<RunSettings> | null;
    return value && Array.isArray(value.profiles) && FRESHNESS.includes(value.freshness!) ? value : null;
  } catch {
    return null;
  }
}

// What the next run searches for and applies to, shared by every page and remembered in this browser
// only. Until something is picked, the defaults come from the profile.
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { data: profile, error, reload: reloadProfile } = useApi<ProfileResponse>('/api/profile');
  const [settings, setState] = useState<RunSettings>(DEFAULT);

  useEffect(() => {
    if (!profile && !error) return;
    const defaults = profile?.defaults;
    setState((current) => {
      const fromProfile = defaults && { autoApply: defaults.autoApply, toleranceMonths: defaults.toleranceMonths };
      const base = current === DEFAULT ? { ...DEFAULT, ...fromProfile, ...saved() } : current;
      return {
        ...base,
        locations: base.locations.length ? base.locations : (defaults?.locations ?? []),
        experienceYears: base.experienceYears ?? defaults?.experienceYears ?? null,
      };
    });
  }, [profile, error]);

  const setSettings = useCallback((patch: Partial<RunSettings>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Remembering the choice is a convenience only.
      }
      return next;
    });
  }, []);

  return <SettingsContext.Provider value={{ settings, setSettings, profile, reloadProfile }}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);

export function scopeQuery(settings: RunSettings): string {
  const query = new URLSearchParams({
    profiles: settings.profiles.join(','),
    locations: settings.locations.join(','),
    freshness: settings.freshness,
    tolerance: String(settings.toleranceMonths),
  });
  if (settings.experienceYears !== null) query.set('experience', String(settings.experienceYears));
  if (settings.freshness === 'custom') {
    if (settings.from) query.set('from', settings.from);
    if (settings.to) query.set('to', settings.to);
  }
  return query.toString();
}

export function scopeOf({ autoApply: _, ...scope }: RunSettings): JobScope {
  return scope;
}
