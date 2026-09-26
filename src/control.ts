import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrowserContext, Page } from 'playwright';
import { createProvider } from './ai/providers.ts';
import { firstPage, launchBrowser } from './browser/browser.ts';
import { BLOCKED_MESSAGE, checkSession, waitForManualLogin } from './browser/session.ts';
import { ConfigError, DEFAULT_DIRS, loadJobProfiles, requireUserProfile, type Dirs, type Env } from './config.ts';
import { setRunPaused } from './db/runs.ts';
import type { Activity, BotState, JobScope, RunKind, SessionStatus, StopCode } from './domain.ts';
import { publish, recordRunEvent } from './events.ts';
import { applySettingsFrom, runApplications, type TrackedRun } from './jobs/runs.ts';
import { log } from './logger.ts';

export class Busy extends Error {
  name = 'Busy';
}

const DESCRIPTIONS: Record<Activity, string> = {
  BROWSER_START: 'The browser is starting',
  SESSION_CHECK: 'A session check is running',
  LOGIN: 'Waiting for you to log in to Naukri',
  SEARCH: 'A job search is running',
  ANALYZE: 'An AI analysis run is active',
  APPLY: 'An auto apply run is already active',
};

const SESSION_AFTER_STOP: Partial<Record<StopCode, SessionStatus>> = {
  SESSION_EXPIRED: 'LOGGED_OUT',
  SECURITY_CHALLENGE: 'CHALLENGE',
  ACCESS_DENIED: 'BLOCKED',
};

// Owns the browser for the dashboard server. One activity at a time: two loops driving the same
// Chrome window would trip over each other. Runs go on in the background; everything the dashboard
// needs to know arrives as events.
export class BotControl {
  #db: DatabaseSync;
  #env: Env;
  #launch: () => Promise<BrowserContext>;
  #dirs: Dirs;
  #waitMs: number | undefined;
  #context: BrowserContext | null = null;
  #page: Page | null = null;
  #abort: AbortController | null = null;
  // Set while an application run is paused; resolves when it is resumed or stopped.
  #paused: { promise: Promise<void>; resolve: () => void } | null = null;
  #running: Promise<unknown> | null = null;
  #loginRechecks = new EventEmitter();
  #state: BotState = { session: 'UNKNOWN', sessionCheckedAt: null, browser: 'STOPPED', activity: null, activeRun: null };

  constructor({
    db,
    env,
    launch,
    dirs = DEFAULT_DIRS,
    waitMs,
  }: { db: DatabaseSync; env: Env; launch?: () => Promise<BrowserContext>; dirs?: Dirs; waitMs?: number }) {
    this.#db = db;
    this.#env = env;
    this.#dirs = dirs;
    this.#waitMs = waitMs;
    this.#launch = launch ?? (() => launchBrowser({ headless: env.HEADLESS, channel: env.BROWSER_CHANNEL, handleSignals: false }));
  }

  get state(): BotState {
    return this.#state;
  }

  #set(patch: Partial<BotState>): void {
    this.#state = { ...this.#state, ...patch };
    publish({ type: 'STATE', state: this.#state, timestamp: new Date().toISOString() });
  }

  #setSession(session: SessionStatus): void {
    this.#set({ session, sessionCheckedAt: new Date().toISOString() });
  }

  #begin(activity: Activity): void {
    if (this.#state.activity) throw new Busy(`${DESCRIPTIONS[this.#state.activity]}. Wait for it to finish or stop it first.`);
    this.#set({ activity });
  }

  #end(): void {
    this.#set({ activity: null, activeRun: null });
  }

  async #ensurePage(): Promise<Page> {
    if (!this.#context) {
      const context = await this.#launch();
      context.on('close', () => {
        if (this.#context !== context) return;
        this.#context = null;
        this.#page = null;
        this.#set({ browser: 'STOPPED' });
      });
      this.#context = context;
      this.#set({ browser: 'RUNNING' });
    }
    if (!this.#page || this.#page.isClosed()) this.#page = await firstPage(this.#context);
    return this.#page;
  }

  async startBrowser(): Promise<void> {
    if (this.#context) return;
    this.#begin('BROWSER_START');
    try {
      await this.#ensurePage();
    } finally {
      this.#end();
    }
  }

  // Refused mid-run: the run would lose its page. Stop the run first.
  async stopBrowser(): Promise<void> {
    if (this.#state.activeRun) throw new Busy(`${DESCRIPTIONS[this.#state.activeRun.kind]}. Stop it before closing the browser.`);
    const context = this.#context;
    if (!context) return;
    // Closing the context is what flushes cookies to data/browser-profile.
    await context.close();
    log.info('Browser closed');
  }

  async checkSession(): Promise<SessionStatus> {
    // While a login is waiting, "check" means "I've finished logging in, look now".
    if (this.#state.activity === 'LOGIN') {
      this.#loginRechecks.emit('line');
      return this.#state.session;
    }
    this.#begin('SESSION_CHECK');
    try {
      const state = await checkSession(await this.#ensurePage());
      this.#setSession(state);
      log.info(`Naukri session: ${state.replace('_', ' ').toLowerCase()}`);
      return state;
    } finally {
      this.#end();
    }
  }

  startLogin(): void {
    if (this.#env.HEADLESS) throw new ConfigError('Logging in needs a visible browser. Set HEADLESS=false in .env and restart the server.');
    this.#begin('LOGIN');
    this.#running = (async () => {
      try {
        const page = await this.#ensurePage();
        await page.bringToFront();
        const state = await checkSession(page);
        if (state === 'LOGGED_IN' || state === 'BLOCKED') {
          this.#setSession(state);
          if (state === 'BLOCKED') log.error(BLOCKED_MESSAGE);
          else log.info('Already logged in to Naukri. The saved session is valid.');
          return;
        }
        this.#setSession('WAITING_FOR_LOGIN');
        log.info('Log in to Naukri in the Chrome window. Complete any OTP or CAPTCHA there yourself.');
        const result = await waitForManualLogin(this.#context!, page, { rechecks: this.#loginRechecks });
        this.#setSession(result === 'LOGGED_IN' ? 'LOGGED_IN' : 'LOGGED_OUT');
        if (result === 'LOGGED_IN') log.info('Naukri session detected and saved');
        else log.warn(result === 'CLOSED' ? 'Browser was closed before login finished' : 'Gave up waiting for login after 10 minutes');
      } catch (err) {
        this.#setSession('UNKNOWN');
        log.error('Login stopped', err);
      } finally {
        this.#end();
      }
    })();
  }

  async #startRun(kind: RunKind, start: (page: Page | null, signal: AbortSignal) => TrackedRun): Promise<string> {
    this.#begin(kind);
    let tracked: TrackedRun;
    const abort = new AbortController();
    try {
      const page = kind === 'ANALYZE' ? null : await this.#ensurePage();
      tracked = start(page, abort.signal);
    } catch (err) {
      this.#end();
      throw err;
    }
    this.#abort = abort;
    this.#set({ activeRun: { id: tracked.runId, kind, startedAt: new Date().toISOString(), paused: false, stopRequested: false } });
    this.#running = tracked.done.then((run) => {
      const session = run.stopCode && SESSION_AFTER_STOP[run.stopCode];
      if (session) this.#setSession(session);
      // Browser runs begin with a session check, so finishing one proves the session.
      else if (kind !== 'ANALYZE' && run.status === 'COMPLETED') this.#setSession('LOGGED_IN');
      this.#abort = null;
      this.#release();
      this.#end();
    });
    return tracked.runId;
  }

  jobProfiles() {
    return loadJobProfiles(this.#dirs.config);
  }

  // Searches Naukri for the chosen profiles, locations and dates, then applies to every eligible job
  // it has, freshest first. `autoApply` off stops each job before Apply.
  startAutoApply(request: JobScope & { autoApply: boolean }): Promise<string> {
    requireUserProfile(this.#dirs);
    const unknown = request.profiles.filter((id) => !this.jobProfiles().some((p) => p.id === id));
    if (unknown.length) throw new ConfigError(`Unknown job profile: ${unknown.join(', ')}`);
    if (request.freshness === 'custom' && !request.from) throw new ConfigError('Pick a start date for the custom range');
    const settings = { ...applySettingsFrom(this.#env, request), autoApply: request.autoApply };
    return this.#startRun('APPLY', (page, signal) =>
      runApplications(page!, this.#db, this.#env, settings, {
        signal,
        whilePaused: () => this.#paused?.promise ?? Promise.resolve(),
        browseDelayMs: [this.#env.DELAY_MIN_MS, this.#env.DELAY_MAX_MS],
        dirs: this.#dirs,
        waitMs: this.#waitMs,
        provider: createProvider(this.#env),
      }),
    );
  }

  // The run finishes the step it is on (it never stops halfway through a click) and then waits.
  pauseRun(): boolean {
    const run = this.#state.activeRun;
    if (!run || run.kind !== 'APPLY' || run.stopRequested) return false;
    if (!run.paused) {
      let resolve = () => {};
      const promise = new Promise<void>((done) => (resolve = done));
      this.#paused = { promise, resolve };
      setRunPaused(this.#db, run.id, true);
      this.#set({ activeRun: { ...run, paused: true } });
      recordRunEvent(this.#db, { type: 'RUN_PAUSED', runId: run.id, status: 'PAUSED', message: 'Paused after the current step. Nothing is clicked while paused.' });
    }
    return true;
  }

  resumeRun(): boolean {
    const run = this.#state.activeRun;
    if (!run?.paused || run.stopRequested) return false;
    setRunPaused(this.#db, run.id, false);
    this.#set({ activeRun: { ...run, paused: false } });
    recordRunEvent(this.#db, { type: 'RUN_RESUMED', runId: run.id, status: 'RUNNING', message: 'Resumed' });
    this.#release();
    return true;
  }

  #release(): void {
    this.#paused?.resolve();
    this.#paused = null;
  }

  // Graceful: the run finishes its current step, never submits because of the stop, and records
  // what it did. Returns false when nothing is running.
  stopRun(reason = 'Stopped from the dashboard'): boolean {
    const run = this.#state.activeRun;
    if (!run || !this.#abort) return false;
    if (!run.stopRequested) {
      this.#abort.abort(reason);
      this.#set({ activeRun: { ...run, paused: false, stopRequested: true } });
      this.#release();
      log.info('Stop requested. Finishing the current step, then saving the run.');
    }
    return true;
  }

  // Settles when the latest background run or login has finished.
  async idle(): Promise<void> {
    await this.#running;
  }

  // Lets an active run reach a safe point first; a pending login simply ends with the browser.
  async shutdown({ graceMs = 60_000 } = {}): Promise<void> {
    this.stopRun('The dashboard server was shut down');
    if (this.#state.activity === 'LOGIN') await this.#context?.close().catch(() => {});
    // An unref'd timer, so it can't keep the process alive once everything else has closed.
    await Promise.race([this.idle(), sleep(graceMs, undefined, { ref: false })]);
    await this.#context?.close().catch(() => {});
  }
}
