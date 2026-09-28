'use client';

import { FRESHNESS, type JobScope, type ProfileResponse } from '@bot/domain';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useApi } from './api';

const KEY = 'job-bot:settings';
// Kept apart from the other settings: an earlier version saved the server's default (off) there.
const AUTO_APPLY_KEY = 'job-bot:auto-apply';

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
  // The dashboard's purpose is applying; the switch turns it off for a check-only run.
  autoApply: true,
};

interface Settings {
  settings: RunSettings;
  setSettings: (patch: Partial<RunSettings>) => void;
  profile: ProfileResponse | undefined;
  reloadProfile: () => void;
}

const SettingsContext = createContext<Settings>({ settings: DEFAULT, setSettings: () => {}, profile: undefined, reloadProfile: () => {} });

function saved(): Partial<RunSettings> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<RunSettings> | null;
    const autoApply = JSON.parse(localStorage.getItem(AUTO_APPLY_KEY) ?? 'null') as unknown;
    const settings = value && Array.isArray(value.profiles) && FRESHNESS.includes(value.freshness!) ? { ...value } : {};
    delete settings.autoApply;
    return typeof autoApply === 'boolean' ? { ...settings, autoApply } : settings;
  } catch {
    return {};
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
      const fromProfile = defaults && { toleranceMonths: defaults.toleranceMonths };
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
        const { autoApply, ...rest } = next;
        localStorage.setItem(KEY, JSON.stringify(rest));
        localStorage.setItem(AUTO_APPLY_KEY, JSON.stringify(autoApply));
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
