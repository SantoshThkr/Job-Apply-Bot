import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { firstPage, launchBrowser } from './browser/browser.ts';
import { BLOCKED_MESSAGE, checkSession, waitForManualLogin, type SessionState } from './browser/session.ts';
import { ROOT, loadEnv, loadProfile, loadSearches, type Env, type Profile } from './config.ts';
import { createProvider } from './ai/providers.ts';
import { matchCounts, rankedJobs } from './db/analysis.ts';
import { openDatabase } from './db/database.ts';
import { JOB_STATUSES, countAwaitingDetails, jobCounts, type JobStatus } from './db/jobs.ts';
import { describeQuery, discoverJobs, fetchMissingDetails, planQueries } from './jobs/discovery.ts';
import { analyzeJobs, applyHardFilters } from './jobs/matching.ts';
import type { MatchBand } from './jobs/scoring.ts';
import { log } from './logger.ts';

const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const SESSION_MESSAGES: Record<SessionState, string> = {
  LOGGED_IN: 'Naukri session detected',
  LOGGED_OUT: 'Not logged in to Naukri. Run `npm run login`.',
  CHALLENGE: 'PAUSED: Naukri is showing a CAPTCHA/OTP check. Run `npm run login` and complete it manually.',
  BLOCKED: BLOCKED_MESSAGE,
};

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

// Search Naukri, drop obvious mismatches from the listing data, then read the remaining descriptions.
async function runSearch(db: DatabaseSync, env: Env, profile: Profile, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { keyword: { type: 'string' }, location: { type: 'string' } } });
  const queries = planQueries(values.keyword ? [] : loadSearches(), profile, values);
  log.info(`${queries.length} search(es) planned, up to ${env.MAX_JOBS_PER_RUN} new jobs`);
  for (const query of queries) log.debug(`  ${describeQuery(query)}`);

  const context = await launchBrowser({ headless: env.HEADLESS, channel: env.BROWSER_CHANNEL });
  try {
    const page = await firstPage(context);
    const state = await checkSession(page);
    if (state !== 'LOGGED_IN') throw new Error(SESSION_MESSAGES[state]);
    log.info(SESSION_MESSAGES[state]);

    const { seen, added } = await discoverJobs(page, db, queries, env);
    log.info(`Found ${seen} jobs, ${added} new`);
    const { rejected } = applyHardFilters(db, profile);
    if (rejected) log.info(`Filtered out ${rejected} job(s) on experience, location or title before reading descriptions`);
    const { fetched, failed } = await fetchMissingDetails(page, db, env);
    if (fetched || failed) log.info(`Descriptions read: ${fetched}${failed ? `, failed: ${failed}` : ''}`);
  } finally {
    await context.close();
    log.info('Browser closed');
  }
}

async function runAnalysis(db: DatabaseSync, env: Env, profile: Profile, force: boolean): Promise<void> {
  const { rejected } = applyHardFilters(db, profile, { recheck: force });
  if (rejected) log.info(`Filtered out ${rejected} job(s) on experience, location or title`);

  const provider = createProvider(env);
  const settings: [string, string | number][] = [
    ['AI provider', provider.label],
    ['Model', provider.model],
    ['Endpoint', provider.endpoint],
    ['Concurrency', env.AI_CONCURRENCY],
  ];
  printTable(settings);

  const summary = await analyzeJobs(db, profile, env, { provider, force });
  if (summary.attempted) {
    const status = !summary.modelChecked
      ? 'not needed (all results cached)'
      : provider.name === 'ollama'
        ? 'running, model installed'
        : 'API key present';
    printTable([
      ['AI provider', provider.label],
      ['Model', provider.model],
      [`${provider.label} status`, status],
      ['Jobs analyzed', summary.attempted],
      ['Successful analyses', summary.succeeded],
      ['Failed analyses', summary.failed],
      ['Cache hits', summary.cacheHits],
      ['Cache misses', summary.cacheMisses],
      ['Average analysis time', summary.averageMs === null ? 'n/a' : `${(summary.averageMs / 1_000).toFixed(1)}s`],
    ]);
    if (summary.failed) log.info('Failed jobs are marked ANALYSIS_FAILED; `npm run analyze -- --force` retries them.');
  } else {
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

async function search(): Promise<void> {
  const env = loadEnv();
  const profile = loadProfile();
  const db = openDatabase();
  try {
    await runSearch(db, env, profile, process.argv.slice(3));
  } finally {
    db.close();
  }
}

async function analyze(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(3), options: { force: { type: 'boolean', default: false } } });
  const env = loadEnv();
  const profile = loadProfile();
  const db = openDatabase();
  try {
    await runAnalysis(db, env, profile, values.force);
    printMatches(db, env);
  } finally {
    db.close();
  }
}

// Search and analysis only. Nothing here opens an application form.
async function dryRun(): Promise<void> {
  const env = loadEnv();
  const profile = loadProfile();
  const db = openDatabase();
  try {
    await runSearch(db, env, profile, process.argv.slice(3));
    await runAnalysis(db, env, profile, false);
    printMatches(db, env);
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

const commands: Record<string, () => Promise<void>> = { login, session, search, analyze, 'dry-run': dryRun, status };

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
