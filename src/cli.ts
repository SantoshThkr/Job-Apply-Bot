import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { firstPage, launchBrowser } from './browser/browser.ts';
import { BLOCKED_MESSAGE, checkSession, waitForManualLogin, type SessionState } from './browser/session.ts';
import { ROOT, loadEnv, loadProfile, loadSearches } from './config.ts';
import { openDatabase } from './db/database.ts';
import { JOB_STATUSES, jobCounts, recentJobs } from './db/jobs.ts';
import { describeQuery, discoverJobs, fetchMissingDetails, planQueries } from './jobs/discovery.ts';
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

async function search(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { keyword: { type: 'string' }, location: { type: 'string' } },
  });
  const env = loadEnv();
  const profile = loadProfile();
  const queries = planQueries(values.keyword ? [] : loadSearches(), profile, values);
  log.info(`${queries.length} search(es) planned, up to ${env.MAX_JOBS_PER_RUN} new jobs`);
  for (const query of queries) log.debug(`  ${describeQuery(query)}`);

  const db = openDatabase();
  const context = await launchBrowser({ headless: env.HEADLESS, channel: env.BROWSER_CHANNEL });
  try {
    const page = await firstPage(context);
    const state = await checkSession(page);
    if (state !== 'LOGGED_IN') throw new Error(SESSION_MESSAGES[state]);
    log.info(SESSION_MESSAGES[state]);

    const { seen, added } = await discoverJobs(page, db, queries, env);
    log.info(`Found ${seen} jobs, ${added} new`);
    const { fetched, failed } = await fetchMissingDetails(page, db, env);
    if (fetched || failed) log.info(`Descriptions read: ${fetched}${failed ? `, failed: ${failed}` : ''}`);
  } finally {
    await context.close();
    db.close();
    log.info('Browser closed');
  }
}

async function status(): Promise<void> {
  const db = openDatabase();
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const counts = jobCounts(db, startOfToday);
    console.log(`Jobs stored:         ${counts.total}`);
    console.log(`Discovered today:    ${counts.discoveredSince}`);
    console.log(`Descriptions read:   ${counts.withDetails}`);
    for (const status of JOB_STATUSES) {
      if (counts.byStatus[status]) console.log(`${`${status}:`.padEnd(21)}${counts.byStatus[status]}`);
    }

    const recent = recentJobs(db, 10);
    if (recent.length) console.log('\nMost recent:');
    for (const job of recent) {
      const facts = [job.company, job.location, job.experience, job.salary].filter(Boolean).join(' | ');
      console.log(`  ${job.title}: ${facts}${job.hasDetails ? '' : ' (no description yet)'}`);
    }
  } finally {
    db.close();
  }
}

const commands: Record<string, () => Promise<void>> = { login, session, search, status };

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
