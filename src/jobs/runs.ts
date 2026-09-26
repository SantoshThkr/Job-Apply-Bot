import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright';
import type { JobAnalysisProvider } from '../ai/analyzer.ts';
import type { SearchQuery } from '../browser/search.ts';
import { RunStopped, requireSession } from '../browser/session.ts';
import { loadAnswers, loadJobProfiles, loadProfile, loadResume, paths, type Answer, type Env, type JobProfile, type Profile } from '../config.ts';
import { createRun, finishRun, getRun } from '../db/runs.ts';
import type { ApplySettings, JobScope, Run, RunKind } from '../domain.ts';
import { publish, recordRunEvent } from '../events.ts';
import { log } from '../logger.ts';
import type { ApplicantFacts } from './answers.ts';
import { applyToJobs } from './applying.ts';
import { searchJobs } from './discovery.ts';
import { analyzeJobs, applyHardFilters } from './matching.ts';

// Search, analysis and application runs, recorded the same way whether the CLI or the dashboard
// started them.

const LABELS: Record<RunKind, string> = { SEARCH: 'Search', ANALYZE: 'AI analysis', APPLY: 'Application run' };

export interface TrackedRun {
  runId: string;
  // Settles with the finished run; never rejects, because how the run ended is recorded on it.
  done: Promise<Run>;
}

function trackRun(
  db: DatabaseSync,
  kind: RunKind,
  settings: Run['settings'],
  signal: AbortSignal | undefined,
  work: (runId: string, stats: Record<string, number>) => Promise<void>,
): TrackedRun {
  const runId = createRun(db, kind, settings);
  recordRunEvent(db, { type: 'RUN_STARTED', runId, message: `${LABELS[kind]} started (${runId})` });
  const stats: Record<string, number> = {};

  const done = (async () => {
    try {
      await work(runId, stats);
      if (signal?.aborted) {
        const reason = String(signal.reason ?? 'Stop requested');
        finishRun(db, runId, 'STOPPED', { stats, stopReason: reason });
        recordRunEvent(db, { type: 'RUN_STOPPED', runId, status: 'STOPPED', message: `${LABELS[kind]} stopped: ${reason}` });
      } else {
        finishRun(db, runId, 'COMPLETED', { stats });
        recordRunEvent(db, { type: 'RUN_COMPLETED', runId, status: 'COMPLETED', message: `${LABELS[kind]} completed` });
      }
    } catch (err) {
      if (err instanceof RunStopped) {
        finishRun(db, runId, 'STOPPED', { stats, stopReason: err.message, stopCode: err.code });
        recordRunEvent(db, { type: 'RUN_STOPPED', runId, status: 'STOPPED', message: `${LABELS[kind]} stopped: ${err.message}`, reason: err.code });
      } else {
        const message = (err as Error).message;
        finishRun(db, runId, 'FAILED', { stats, stopReason: message });
        recordRunEvent(db, { type: 'RUN_FAILED', runId, status: 'FAILED', message: `${LABELS[kind]} failed: ${message}` });
        if (err instanceof Error && err.stack) log.debug(err.stack);
      }
    }
    return getRun(db, runId)!;
  })();
  return { runId, done };
}

export function runSearch(
  page: Page,
  db: DatabaseSync,
  env: Env,
  profile: Profile,
  jobProfiles: JobProfile[],
  queries: SearchQuery[],
  { scope, provider, signal }: { scope?: JobScope; provider?: JobAnalysisProvider; signal?: AbortSignal } = {},
): TrackedRun {
  const settings = {
    keywords: [...new Set(queries.map((q) => q.keyword))],
    profiles: scope?.profiles ?? [],
    freshness: scope?.freshness ?? 'all',
    matched: Boolean(provider),
  };
  return trackRun(db, 'SEARCH', settings, signal, async (runId, stats) => {
    await requireSession(page);
    await searchJobs(page, db, env, profile, jobProfiles, queries, { stats, scope, signal });
    // The dashboard's Search also matches what it found, so new jobs can be applied to right after.
    if (provider && !signal?.aborted) Object.assign(stats, await match(runId, db, env, profile, jobProfiles, { provider, scope, signal }));
  });
}

async function match(
  runId: string,
  db: DatabaseSync,
  env: Env,
  profile: Profile,
  jobProfiles: JobProfile[],
  options: { provider: JobAnalysisProvider; force?: boolean; scope?: JobScope; signal?: AbortSignal },
): Promise<Record<string, number>> {
  const summary = await analyzeJobs(db, profile, env, {
    ...options,
    jobProfiles,
    onProgress: (progress) => publish({ type: 'ANALYSIS_PROGRESS', runId, ...progress, timestamp: new Date().toISOString() }),
  });
  return {
    attempted: summary.attempted,
    succeeded: summary.succeeded,
    failed: summary.failed,
    cacheHits: summary.cacheHits,
    cacheMisses: summary.cacheMisses,
    modelChecked: Number(summary.modelChecked),
    ...(summary.averageMs !== null && { averageMs: Math.round(summary.averageMs) }),
  };
}

export function runAnalysis(
  db: DatabaseSync,
  env: Env,
  profile: Profile,
  jobProfiles: JobProfile[],
  { provider, force = false, signal }: { provider: JobAnalysisProvider; force?: boolean; signal?: AbortSignal },
): TrackedRun {
  const settings = { provider: provider.name, model: provider.model, minMatchScore: env.MIN_MATCH_SCORE, force };
  return trackRun(db, 'ANALYZE', settings, signal, async (runId, stats) => {
    const { rejected } = applyHardFilters(db, profile, jobProfiles);
    stats.filtered = rejected;
    if (rejected) log.info(`Filtered out ${rejected} job(s) on location or title`);
    Object.assign(stats, await match(runId, db, env, profile, jobProfiles, { provider, force, signal }));
  });
}

// What forms and recruiter questions can be answered from. config/answers.json and config/resume.json
// are optional: without them, a question only they could answer goes to review.
export function loadApplicationConfig(
  dir: string,
  profile: Profile | null,
): { answers: Answer[]; facts: ApplicantFacts | null; resumePath: string | null } {
  const has = (file: string) => existsSync(join(dir, file));
  const resume = has('resume.json') ? loadResume(dir) : null;
  const facts: ApplicantFacts | null = profile && {
    name: profile.name,
    experienceYears: profile.experienceYears,
    skills: [...profile.primarySkills, ...profile.secondarySkills],
    email: resume?.email,
    phone: resume?.phone,
    currentLocation: resume?.currentLocation || undefined,
    currentTitle: resume?.currentTitle,
    noticePeriodDays: resume?.noticePeriodDays,
    expectedSalary: resume?.expectedSalary || undefined,
  };
  return { answers: has('answers.json') ? loadAnswers(dir) : [], facts, resumePath: resume?.resumePath ?? null };
}

export function runApplications(
  page: Page,
  db: DatabaseSync,
  settings: ApplySettings,
  {
    signal,
    whilePaused,
    browseDelayMs,
    configDir = paths.config,
    waitMs,
  }: { signal?: AbortSignal; whilePaused?: () => Promise<void>; browseDelayMs?: [number, number]; configDir?: string; waitMs?: number } = {},
): TrackedRun {
  return trackRun(db, 'APPLY', { ...settings }, signal, async (runId, stats) => {
    const profile = existsSync(join(configDir, 'profile.json')) ? loadProfile(configDir) : null;
    // Profiles decide which jobs are in scope, and job-profiles.json may have changed since the search.
    if (profile) applyHardFilters(db, profile, loadJobProfiles(configDir));
    const config = loadApplicationConfig(configDir, profile);
    if (!existsSync(join(configDir, 'answers.json'))) log.warn('config/answers.json not found: recruiter questions only get answers your profile covers');
    await requireSession(page);
    await applyToJobs({ page, db, runId, settings, ...config, signal, whilePaused, browseDelayMs, waitMs }, stats);
  });
}

export function applySettingsFrom(env: Env, scope: JobScope = { profiles: [], freshness: 'all' }): ApplySettings {
  return {
    ...scope,
    minMatchScore: env.MIN_MATCH_SCORE,
    autoApply: env.AUTO_APPLY,
    autoFill: env.AUTO_FILL,
    delaySeconds: Math.round(env.APPLY_DELAY_MS / 1_000),
    debugScreenshots: env.DEBUG_SCREENSHOTS,
    limit: null,
  };
}
