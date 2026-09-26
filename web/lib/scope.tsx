'use client';

import { FRESHNESS, type JobScope } from '@bot/domain';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

const KEY = 'job-bot:scope';
const DEFAULT: JobScope = { profiles: [], freshness: 'all' };

const ScopeContext = createContext<{ scope: JobScope; setScope: (scope: JobScope) => void }>({ scope: DEFAULT, setScope: () => {} });

// The profiles and freshness picked on the Jobs page, shared with the Apply page and remembered in
// this browser only. Nothing else is stored client-side.
export function ScopeProvider({ children }: { children: ReactNode }) {
  const [scope, setScopeState] = useState<JobScope>(DEFAULT);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as JobScope | null;
      if (saved && Array.isArray(saved.profiles) && FRESHNESS.includes(saved.freshness)) setScopeState(saved);
    } catch {
      // Private windows and blocked storage just start from the default.
    }
  }, []);

  const setScope = useCallback((next: JobScope) => {
    setScopeState(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Remembering the choice is a convenience only.
    }
  }, []);

  return <ScopeContext.Provider value={{ scope, setScope }}>{children}</ScopeContext.Provider>;
}

export const useScope = () => useContext(ScopeContext);

export const scopeQuery = (scope: JobScope) => new URLSearchParams({ profiles: scope.profiles.join(','), freshness: scope.freshness }).toString();
