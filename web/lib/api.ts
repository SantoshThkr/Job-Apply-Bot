'use client';

import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Every request goes to /api on this origin; Next forwards it to the bot's server on 127.0.0.1.
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'The bot server is not reachable. Start it with `npm run server`.');
  }
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    const fallback = res.status >= 500 ? 'The bot server is not reachable. Start it with `npm run server`.' : `Request failed (${res.status})`;
    throw new ApiError(res.status, data?.error ?? fallback);
  }
  return data as T;
}

export const post = <T,>(path: string, body: unknown = {}) => api<T>(path, body);

// GETs `path` (skipped while null) and again whenever `refresh` changes.
export function useApi<T>(path: string | null, refresh: unknown = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let current = true;
    api<T>(path).then(
      (result) => {
        if (!current) return;
        setData(result);
        setError(null);
      },
      (err: Error) => current && setError(err.message),
    );
    return () => {
      current = false;
    };
  }, [path, refresh, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, reload };
}
