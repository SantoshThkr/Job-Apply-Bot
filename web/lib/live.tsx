'use client';

import { FINAL_EVENTS, type AnalysisProgressEvent, type BotEvent, type BotState, type LogEvent, type RunEvent } from '@bot/domain';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const LOG_LIMIT = 200;

export interface Live {
  connected: boolean;
  state: BotState | null;
  log: LogEvent[];
  // The latest run's own events plus the steps of the job it is on. Earlier jobs are dropped, so a
  // run through a thousand jobs doesn't pile up in the page.
  run: RunEvent[];
  analysis: AnalysisProgressEvent | null;
  // Bumps whenever stored data changed (an attempt or a run finished), so views refetch.
  version: number;
}

const initial: Live = { connected: false, state: null, log: [], run: [], analysis: null, version: 0 };
const LiveContext = createContext<Live>(initial);

const DATA_CHANGES = new Set<BotEvent['type']>([...Object.values(FINAL_EVENTS), 'RUN_STARTED', 'RUN_STOPPED', 'RUN_COMPLETED', 'RUN_FAILED', 'RUN_PAUSED']);

export function reduce(live: Live, event: BotEvent): Live {
  switch (event.type) {
    case 'STATE':
      return { ...live, state: event.state };
    case 'LOG':
      return { ...live, log: [...live.log.slice(-(LOG_LIMIT - 1)), event] };
    case 'ANALYSIS_PROGRESS':
      return { ...live, analysis: event };
    default: {
      const sameRun = event.type !== 'RUN_STARTED' && live.run[0]?.runId === event.runId;
      const kept = !sameRun ? [] : event.type === 'JOB_STARTED' ? live.run.filter((e) => e.applicationId === undefined) : live.run;
      return {
        ...live,
        run: [...kept, event],
        analysis: event.type === 'RUN_STARTED' ? null : live.analysis,
        version: live.version + (DATA_CHANGES.has(event.type) ? 1 : 0),
      };
    }
  }
}

// One EventSource for the whole dashboard. The browser reconnects by itself; the server then
// replays its recent events after a STATE snapshot, so the buffers restart from that snapshot.
export function LiveProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<Live>(initial);

  useEffect(() => {
    const source = new EventSource('/api/events');
    let fresh = true;
    source.onopen = () => {
      fresh = true;
      setLive((current) => ({ ...current, connected: true }));
    };
    source.onerror = () => setLive((current) => ({ ...current, connected: false }));
    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as BotEvent;
      const reset = fresh;
      fresh = false;
      setLive((current) => reduce(reset ? { ...initial, connected: true, version: current.version + 1 } : current, event));
    };
    return () => source.close();
  }, []);

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);
