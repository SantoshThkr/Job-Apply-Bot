import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import type { Page } from 'playwright';
import { createApi } from './api.ts';
import { firstPage, launchBrowser } from './browser/browser.ts';
import { BLOCKED_MESSAGE, SESSION_MESSAGES, checkSession, disableManualPauses, waitForManualLogin } from './browser/session.ts';
import { ConfigError, ROOT, loadEnv, loadJobProfiles, loadProfile, matchProfile, requireUserProfile, type Env, type JobProfile, type Profile } from './config.ts';
import { createProvider } from './ai/providers.ts';
import { matchCounts, rankedJobs } from './db/analysis.ts';
import { listApplications, scopeSummary } from './db/applications.ts';
import { openDatabase } from './db/database.ts';
import { countAwaitingDetails, jobCounts } from './db/jobs.ts';
import { closeAbandonedRuns, getRun, listRuns } from './db/runs.ts';
import { BotControl } from './control.ts';
import { FRESHNESS, JOB_STATUSES, type Freshness, type JobScope, type JobStatus, type MatchBand, type Run } from './domain.ts';
import { planQueries } from './jobs/discovery.ts';
import { applyHardFilters } from './jobs/matching.ts';
import { applySettingsFrom, loadApplicationConfig, runAnalysis, runApplications, runSearch } from './jobs/runs.ts';
import { isAnsweredBy } from './jobs/applying.ts';
import { log } from './logger.ts';
import { formatRunReport } from './report.ts';

const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function login(): Promise<void> {
  const env = loadEnv();
  // Always visible: only the user types credentials and answers OTP/CAPTCHA.
  const context = await launchBrowser({ headless: false, channel: env.BROWSER_CHANNEL });
  try {
    const page = await firstPage(context);
    const state = await checkSession(page);
    if (state === 'LOGGED_IN') {
      log.info('Already logged in to Naukri. The saved session is valid.');
      return;
    }
    if (state === 'BLOCKED') throw new Error(BLOCKED_MESSAGE);

    log.info('Log in to Naukri in the Chrome window. Complete any OTP or CAPTCHA there yourself.');
    log.info('This continues on its own once your Naukri homepage opens. Press Enter here if it does not.');
    const result = await waitForManualLogin(context, page);
    if (result === 'LOGGED_IN') {
      log.info('Naukri session detected and saved. Future runs will reuse it.');
    } else {
      log.error(result === 'CLOSED' ? 'Browser was closed before login finished' : 'Gave up waiting for login after 10 minutes');
      process.exitCode = 1;
    }
  } finally {
    // Closing the context is what flushes cookies to data/browser-profile.
    await context.close();
    log.info('Browser closed');
  }
}

async function session(): Promise<void> {
  const env = loadEnv();
  const context = await launchBrowser({ headless: env.HEADLESS, channel: env.BROWSER_CHANNEL });
  try {
    const state = await checkSession(await firstPage(context));
    if (state === 'LOGGED_IN') {
      log.info(SESSION_MESSAGES[state]);
    } else {
      log.warn(SESSION_MESSAGES[state]);
      process.exitCode = 1;
    }
  } finally {
    await context.close();
    log.info('Browser closed');
  }
}

// Ctrl+C stops the run at a safe point: the job in hand is finished and recorded first. A second
// Ctrl+C quits at once (Playwright still closes Chrome on exit).
async function stoppable<T>(use: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = () => {
    log.info('Ctrl+C: stopping at a safe point. Press Ctrl+C again to quit at once.');
    process.once('SIGINT', () => process.exit(130));
    controller.abort('Stopped with Ctrl+C');
  };
  process.once('SIGINT', stop);
  try {
    return await use(controller.signal);
  } finally {
    process.off('SIGINT', stop);
  }
}

async function withBrowser<T>(env: Env, use: (page: Page, signal: AbortSignal) => Promise<T>): Promise<T> {
  // Chrome stays open on Ctrl+C until the run has stopped; closing it here saves the session.
  const context = await launchBrowser({ headless: env.HEADLESS, channel: env.BROWSER_CHANNEL, handleSignals: false });
  try {
    const page = await firstPage(context);
    return await stoppable((signal) => use(page, signal));
  } finally {
    await context.close();
    log.info('Browser closed');
  }
}

// A run that stopped or failed has already said why; the exit code tells scripts.
function exitWith(run: Run): Run {
  if (run.status !== 'COMPLETED') process.exitCode = 1;
  return run;
}

// --profile frontend,react (ids from config/job-profiles.json), --fresh today|24h|2d|3d|7d|all, or
// --from 2026-09-20 [--to 2026-09-26] for a custom range, and --location Bangalore,Remote.
const SCOPE_OPTIONS = {
  profile: { type: 'string' },
  fresh: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  location: { type: 'string' },
} as const;

const list = (value: string | undefined) => value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];

function scopeFrom(values: { profile?: string; fresh?: string; from?: string; to?: string; location?: string }, jobProfiles: JobProfile[]): JobScope {
  const profiles = list(values.profile);
  const unknown = profiles.filter((id) => !jobProfiles.some((p) => p.id === id));
  if (unknown.length) throw new ConfigError(`Unknown --profile ${unknown.join(', ')}. Profiles: ${jobProfiles.map((p) => p.id).join(', ')}`);
  const freshness = (values.from ? 'custom' : (values.fresh ?? 'all')) as Freshness;
  if (!FRESHNESS.includes(freshness)) throw new ConfigError(`--fresh must be one of ${FRESHNESS.join(', ')}`);
  for (const day of [values.from, values.to]) {
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ConfigError('--from and --to take dates as YYYY-MM-DD');
  }
  return { profiles, freshness, from: values.from ?? null, to: values.to ?? null, locations: list(values.location) };
}

async function runSearchCommand(db: DatabaseSync, env: Env, profile: Profile, args: string[]): Promise<Run> {
  const { values } = parseArgs({ args, options: { keyword: { type: 'string' }, ...SCOPE_OPTIONS } });
  const jobProfiles = loadJobProfiles();
  const scope = scopeFrom(values, jobProfiles);
  const chosen = scope.profiles.length ? jobProfiles.filter((p) => scope.profiles.includes(p.id)) : jobProfiles;
  const queries = planQueries(chosen, profile, {
    keywords: values.keyword ? [values.keyword] : [],
    locations: scope.locations,
    freshness: scope.freshness,
    from: scope.from,
  });
  return withBrowser(env, async (page, signal) => exitWith(await runSearch(page, db, env, profile, jobProfiles, queries, { scope, signal }).done));
}

async function runAnalysisCommand(db: DatabaseSync, env: Env, profile: Profile, force: boolean): Promise<void> {
  const provider = createProvider(env);
  printTable([
    ['AI provider', provider.label],
    ['Model', provider.model],
    ['Endpoint', provider.endpoint],
    ['Concurrency', env.AI_CONCURRENCY],
  ]);

  const { stats } = exitWith(await stoppable((signal) => runAnalysis(db, env, profile, loadJobProfiles(), { provider, force, signal }).done));
  if (stats.attempted) {
    const status = !stats.modelChecked
      ? 'not needed (all results cached)'
      : provider.name === 'ollama'
        ? 'running, model installed'
        : 'API key present';
    printTable([
      ['AI provider', provider.label],
      ['Model', provider.model],
      [`${provider.label} status`, status],
      ['Jobs analyzed', stats.attempted],
      ['Successful analyses', stats.succeeded ?? 0],
      ['Failed analyses', stats.failed ?? 0],
      ['Cache hits', stats.cacheHits ?? 0],
      ['Cache misses', stats.cacheMisses ?? 0],
      ['Average analysis time', stats.averageMs === undefined ? 'n/a' : `${(stats.averageMs / 1_000).toFixed(1)}s`],
    ]);
    if (stats.failed) log.info('Failed jobs are marked ANALYSIS_FAILED; `npm run analyze -- --force` retries them.');
  } else if (stats.attempted === 0) {
    log.info('No jobs waiting for analysis');
  }
  const waiting = countAwaitingDetails(db);
  if (waiting) log.info(`${waiting} job(s) still need their description read; run \`npm run search\` to fetch them`);
}

function printTable(rows: [string, string | number][]): void {
  console.log('');
  for (const [label, value] of rows) console.log(`${`${label}:`.padEnd(24)}${value}`);
  console.log('');
}

const BAND_LABELS: Record<MatchBand, string> = { HIGH_MATCH: 'HIGH MATCH', MATCH: 'MATCH', REVIEW: 'REVIEW', SKIP: 'SKIP' };

function printMatches(db: DatabaseSync, env: Env): void {
  const groups: [string, JobStatus, number][] = [
    [`Shortlisted (score ${env.MIN_MATCH_SCORE}+)`, 'SHORTLISTED', 20],
    ['Review (worth a manual look)', 'REVIEW', 10],
  ];
  for (const [heading, status, limit] of groups) {
    const jobs = rankedJobs(db, [status], limit);
    if (!jobs.length) continue;
    console.log(`\n${heading}`);
    for (const job of jobs) {
      console.log(`  ${String(job.score).padStart(3)}  ${BAND_LABELS[job.band].padEnd(10)}  ${[job.title, job.company, job.location].filter(Boolean).join(' · ')}`);
      console.log(`       ${job.reason}`);
      const skills = [
        job.matchedSkills.length && `Matched: ${job.matchedSkills.join(', ')}`,
        job.missingSkills.length && `Missing: ${job.missingSkills.join(', ')}`,
      ].filter(Boolean);
      if (skills.length) console.log(`       ${skills.join(' | ')}`);
      if (job.redFlags.length) console.log(`       Red flags: ${job.redFlags.join('; ')}`);
      console.log(`       ${job.url}`);
    }
  }
}

// Every command that writes to the database first closes runs a crashed process left open.
function openDb(): DatabaseSync {
  const db = openDatabase();
  closeAbandonedRuns(db);
  return db;
}

async function search(): Promise<void> {
  const env = loadEnv();
  const profile = loadProfile();
  const db = openDb();
  try {
    await runSearchCommand(db, env, profile, process.argv.slice(3));
  } finally {
    db.close();
  }
}

async function analyze(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(3), options: { force: { type: 'boolean', default: false } } });
  const env = loadEnv();
  const profile = loadProfile();
  const db = openDb();
  try {
    await runAnalysisCommand(db, env, profile, values.force);
    printMatches(db, env);
  } finally {
    db.close();
  }
}

// Search and analysis only. Nothing here opens an application form.
async function dryRun(): Promise<void> {
  const env = loadEnv();
  const profile = loadProfile();
  const db = openDb();
  try {
    const search = await runSearchCommand(db, env, profile, process.argv.slice(3));
    if (search.status === 'STOPPED') return;
    await runAnalysisCommand(db, env, profile, false);
    printMatches(db, env);
  } finally {
    db.close();
  }
}

function intOption(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function printReport(db: DatabaseSync, run: Run): void {
  console.log(`\n${formatRunReport(run, listApplications(db, { runId: run.id }))}\n`);
}

// The same run as the dashboard's Start: search, then apply to every eligible job, freshest first.
// Without --auto-apply (or AUTO_APPLY=true) it only checks each job and stops before Apply, because on
// Naukri that click sends the application. --skip-search applies to the jobs already stored.
async function apply(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      max: { type: 'string' },
      'min-score': { type: 'string' },
      'auto-apply': { type: 'boolean', default: false },
      'skip-search': { type: 'boolean', default: false },
      experience: { type: 'string' },
      tolerance: { type: 'string' },
      ...SCOPE_OPTIONS,
    },
  });
  const env = loadEnv();
  const user = requireUserProfile().profile;
  const settings = applySettingsFrom(
    env,
    {
      ...scopeFrom(values, loadJobProfiles()),
      experienceYears: values.experience === undefined ? user.experienceYears : Number(values.experience),
      toleranceMonths: intOption(values.tolerance, 'tolerance', 0, 60) ?? user.experienceToleranceMonths,
    },
    values['auto-apply'] || env.AUTO_APPLY,
  );
  if (!settings.locations?.length) settings.locations = matchProfile(user).preferredLocations;
  settings.limit = intOption(values.max, 'max', 1, 1_000_000) ?? null;
  settings.minMatchScore = intOption(values['min-score'], 'min-score', 0, 100) ?? settings.minMatchScore;
  settings.search = !values['skip-search'];
  printTable([
    ['Profiles', settings.profiles.join(', ') || 'all'],
    ['Locations', settings.locations.join(', ') || 'anywhere'],
    ['Posted', settings.freshness === 'custom' ? `${settings.from} to ${settings.to ?? 'today'}` : settings.freshness],
    ['Experience', `${settings.experienceYears} years, ${settings.toleranceMonths} months tolerance`],
    ['Search first', settings.search ? 'yes' : 'no'],
    ['Jobs', settings.limit ? `first ${settings.limit} in the queue` : 'every eligible job'],
    ['Auto apply', settings.autoApply ? 'ON (applications will be sent)' : 'OFF (stops before Apply)'],
  ]);

  const db = openDb();
  try {
    const browseDelayMs: [number, number] = [env.DELAY_MIN_MS, env.DELAY_MAX_MS];
    await withBrowser(env, async (page, signal) =>
      printReport(db, exitWith(await runApplications(page, db, env, settings, { browseDelayMs, signal, provider: createProvider(env) }).done)),
    );
  } finally {
    db.close();
  }
}

// The report for one run: `npm run report -- RUN-20260925-233612`, or the latest application run.
async function report(): Promise<void> {
  const id = process.argv[3];
  const db = openDatabase();
  try {
    const run = id ? getRun(db, id) : listRuns(db, { kind: 'APPLY', limit: 1 })[0];
    if (!run) throw new Error(id ? `No run ${id}` : 'No application runs yet');
    printReport(db, run);
  } finally {
    db.close();
  }
}

async function status(): Promise<void> {
  const db = openDatabase();
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const jobs = jobCounts(db, startOfToday);
    const matches = matchCounts(db);
    const config = loadApplicationConfig();
    const { counts: applications } = scopeSummary(db, {
      scope: { profiles: [], freshness: 'all', experienceYears: config.facts?.experienceYears ?? null },
      minMatchScore: loadEnv().MIN_MATCH_SCORE,
      isAnswered: isAnsweredBy(config.answers, config.facts),
    });
    const rows: [string, number][] = [
      ['Jobs stored', jobs.total],
      ['Discovered today', jobs.discoveredSince],
      ['Descriptions read', jobs.withDetails],
      ['Analyzed', matches.analyzed],
      ['High matches (90+)', matches.highMatches],
      ['Shortlisted', matches.shortlisted],
      ['Review', matches.review],
      ['Skipped by AI score', matches.skippedByAi],
      ['Filtered out early', matches.skippedByFilter],
      ['Analysis failed', matches.analysisFailed],
      ['Waiting for analysis', jobs.byStatus.DISCOVERED ?? 0],
      ['Ready to apply', applications.ready],
      ['Applied (confirmed)', applications.applied],
      ['Already applied', applications.already_applied],
      ['Application failed', applications.failed],
      ['External', applications.external],
      ['Needs review', applications.review],
      ['Not eligible', applications.not_eligible],
    ];
    for (const [label, value] of rows) console.log(`${`${label}:`.padEnd(24)}${String(value).padStart(5)}`);
    for (const status of JOB_STATUSES.slice(JOB_STATUSES.indexOf('APPLICATION_STARTED'))) {
      if (jobs.byStatus[status]) console.log(`${`${status}:`.padEnd(24)}${String(jobs.byStatus[status]).padStart(5)}`);
    }
    printMatches(db, loadEnv());
  } finally {
    db.close();
  }
}

// The local API the dashboard talks to. It owns the browser while it runs; the other commands can't
// open the same Chrome profile meanwhile.
async function server(): Promise<void> {
  const env = loadEnv();
  const db = openDb();
  disableManualPauses();
  const control = new BotControl({ db, env });
  // Sorts jobs into the current job profiles and cities before the dashboard lists them.
  try {
    applyHardFilters(db, loadJobProfiles());
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    log.warn(err.message);
  }

  const api = createApi({ control, db, env });
  await new Promise<void>((resolve, reject) => {
    api.once('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EADDRINUSE' ? new ConfigError(`Port ${env.API_PORT} is in use. Stop the other server or set API_PORT in .env.`) : err),
    );
    api.listen(env.API_PORT, '127.0.0.1', resolve);
  });
  log.info(`Dashboard API on http://127.0.0.1:${env.API_PORT}. Start the dashboard with \`npm run web\` and open http://127.0.0.1:3000`);

  const signal = await new Promise<string>((resolve) => {
    for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => resolve(name));
  });
  log.info(`${signal}: stopping any run at a safe point, then closing Chrome. Press Ctrl+C again to quit at once.`);
  process.once('SIGINT', () => process.exit(130));
  await control.shutdown();
  api.closeAllConnections();
  api.close();
  db.close();
}

const commands: Record<string, () => Promise<void>> = { login, session, search, analyze, 'dry-run': dryRun, apply, report, status, server };

const name = process.argv[2] ?? '';
const command = commands[name];
if (!command) {
  console.error(`Usage: node src/cli.ts <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}

try {
  await command();
} catch (err) {
  log.error(`${name} stopped`, err);
  process.exitCode = 1;
}
