import type { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright';
import type { JobAnalysisProvider } from '../ai/analyzer.ts';
import type { SearchQuery } from '../browser/search.ts';
import { RunStopped, requireSession } from '../browser/session.ts';
import {
  DEFAULT_DIRS,
  loadAnswers,
  loadJobProfiles,
  loadUserProfile,
  matchProfile,
  requireUserProfile,
  type Answer,
  type Dirs,
  type Env,
  type JobProfile,
  type LoadedProfile,
  type Profile,
} from '../config.ts';
import { applicationQueue, scopeSummary } from '../db/applications.ts';
import { createRun, finishRun, getRun, saveRunStats } from '../db/runs.ts';
import type { ApplySettings, JobScope, Run, RunKind } from '../domain.ts';
import { publish, recordRunEvent } from '../events.ts';
import { log } from '../logger.ts';
import type { ApplicantFacts } from './answers.ts';
import { applyToJobs, isAnsweredBy } from './applying.ts';
import { discoverJobs, planQueries, searchJobs } from './discovery.ts';
import { analyzeJobs, applyHardFilters, matchInBackground } from './matching.ts';

// Search, analysis and application runs, recorded the same way whether the CLI or the dashboard
// started them.

const LABELS: Record<RunKind, string> = { SEARCH: 'Search', ANALYZE: 'AI analysis', APPLY: 'Auto apply run' };

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

// Search only, for the command line: stores new jobs and reads their descriptions for `npm run analyze`.
export function runSearch(
  page: Page,
  db: DatabaseSync,
  env: Env,
  profile: Profile,
  jobProfiles: JobProfile[],
  queries: SearchQuery[],
  { scope, signal }: { scope?: JobScope; signal?: AbortSignal } = {},
): TrackedRun {
  const settings = { keywords: [...new Set(queries.map((q) => q.keyword))], profiles: scope?.profiles ?? [], freshness: scope?.freshness ?? 'all' };
  return trackRun(db, 'SEARCH', settings, signal, async (_, stats) => {
    await requireSession(page);
    await searchJobs(page, db, env, profile, jobProfiles, queries, { stats, scope, signal });
  });
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
    const { rejected } = applyHardFilters(db, jobProfiles);
    stats.filtered = rejected;
    if (rejected) log.info(`Set aside ${rejected} job(s) that match none of your job profiles`);
    const summary = await analyzeJobs(db, profile, env, {
      provider,
      jobProfiles,
      force,
      signal,
      onProgress: (progress) => publish({ type: 'ANALYSIS_PROGRESS', runId, ...progress, timestamp: new Date().toISOString() }),
    });
    Object.assign(stats, {
      attempted: summary.attempted,
      succeeded: summary.succeeded,
      failed: summary.failed,
      cacheHits: summary.cacheHits,
      cacheMisses: summary.cacheMisses,
      modelChecked: Number(summary.modelChecked),
      ...(summary.averageMs !== null && { averageMs: Math.round(summary.averageMs) }),
    });
  });
}

export interface ApplicationConfig {
  answers: Answer[];
  facts: ApplicantFacts | null;
  resumePath: string | null;
}

// What forms and recruiter questions can be answered from: the saved answers and the profile.
export function applicationConfig(loaded: LoadedProfile | null, answers: Answer[]): ApplicationConfig {
  if (!loaded) return { answers, facts: null, resumePath: null };
  const p = loaded.profile;
  const facts: ApplicantFacts = {
    name: [p.firstName, p.lastName].filter(Boolean).join(' '),
    firstName: p.firstName,
    lastName: p.lastName || undefined,
    experienceYears: p.experienceYears,
    skills: [...p.skills, ...p.otherSkills],
    email: p.email || undefined,
    phone: p.phone || undefined,
    currentLocation: p.location || undefined,
    currentTitle: p.currentRole || undefined,
    currentCompany: p.currentCompany || undefined,
    noticePeriodDays: p.noticePeriodDays ?? undefined,
    currentSalary: p.currentSalary || undefined,
    expectedSalary: p.expectedSalary || undefined,
  };
  return { answers, facts, resumePath: loaded.resumePath };
}

export function loadApplicationConfig(dirs: Dirs = DEFAULT_DIRS): ApplicationConfig {
  return applicationConfig(loadUserProfile(dirs), loadAnswers(dirs));
}

// The whole job: search Naukri, sort what it found, then apply to every eligible job, freshest first,
// while the AI scores jobs in the background. Nothing waits for the AI.
export function runApplications(
  page: Page,
  db: DatabaseSync,
  env: Env,
  settings: ApplySettings,
  {
    signal,
    whilePaused,
    browseDelayMs,
    dirs = DEFAULT_DIRS,
    waitMs,
    provider,
  }: {
    signal?: AbortSignal;
    whilePaused?: () => Promise<void>;
    browseDelayMs?: [number, number];
    dirs?: Dirs;
    waitMs?: number;
    provider?: JobAnalysisProvider;
  } = {},
): TrackedRun {
  return trackRun(db, 'APPLY', { ...settings }, signal, async (runId, stats) => {
    const loaded = requireUserProfile(dirs);
    const profile = matchProfile(loaded.profile);
    const jobProfiles = loadJobProfiles(dirs.config);
    const config = applicationConfig(loaded, loadAnswers(dirs));
    await requireSession(page);

    if (settings.search) {
      const chosen = settings.profiles.length ? jobProfiles.filter((p) => settings.profiles.includes(p.id)) : jobProfiles;
      const queries = planQueries(chosen, profile, { locations: settings.locations, freshness: settings.freshness, from: settings.from });
      log.info(`Searching Naukri: ${queries.length} search(es)`);
      const onPage = (progress: { found: number; added: number }) =>
        publish({ type: 'SEARCH_PROGRESS', runId, ...progress, timestamp: new Date().toISOString() });
      const { found, added } = await discoverJobs(page, db, queries, env, { signal, whilePaused, onPage });
      Object.assign(stats, { searches: queries.length, found, new: added });
      saveRunStats(db, runId, stats);
      recordRunEvent(db, { type: 'SEARCH_FINISHED', runId, message: `Search finished: ${found} jobs found, ${added} new`, detail: { found, new: added } });
    }
    applyHardFilters(db, jobProfiles);
    if (signal?.aborted) return;

    const options = { scope: settings, minMatchScore: settings.minMatchScore, isAnswered: isAnsweredBy(config.answers, config.facts) };
    const summary = scopeSummary(db, options);
    const { jobs } = applicationQueue(db, options);
    const funnel = {
      relevant: summary.found,
      eligible: summary.eligible,
      notEligible: summary.counts.not_eligible,
      alreadyApplied: summary.counts.applied + summary.counts.already_applied,
      external: summary.counts.external,
      queued: jobs.length,
    };
    Object.assign(stats, funnel);
    saveRunStats(db, runId, stats);
    recordRunEvent(db, {
      type: 'QUEUE_READY',
      runId,
      message: `${funnel.relevant} relevant, ${funnel.eligible} eligible, ${funnel.queued} to apply to`,
      detail: funnel,
    });

    const matching = new AbortController();
    const matcher = provider
      ? matchInBackground(db, profile, env, { provider, jobProfiles, scope: settings, signal: signal ? AbortSignal.any([signal, matching.signal]) : matching.signal })
      : null;
    try {
      await applyToJobs({ page, db, runId, settings, ...config, signal, whilePaused, browseDelayMs, waitMs }, jobs, stats);
    } finally {
      matching.abort();
      const matched = await matcher;
      if (matched) Object.assign(stats, { aiMatched: matched.matched, aiFailed: matched.failed });
    }
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
    search: true,
    limit: null,
  };
}
