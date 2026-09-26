import type { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { BrowserContext, Frame, Page } from 'playwright';
import type { SessionState, StopCode } from '../domain.ts';
import { log } from '../logger.ts';
import { CHALLENGE_SELECTORS, NAUKRI_PATHS, NAUKRI_URLS, SESSION_SELECTORS } from './selectors.ts';

export type LoginResult = 'LOGGED_IN' | 'CLOSED' | 'TIMED_OUT';

const LOGIN_TIMEOUT_MS = 10 * 60_000;

export const BLOCKED_MESSAGE =
  'Naukri refused this browser (Access Denied). This happens with HEADLESS=true or after too many requests. ' +
  'Wait a while and retry with a visible browser; the bot will not try to get around it.';

// Ends a run on purpose (blocked, logged out, unsolved security check) rather than failing one step.
export class RunStopped extends Error {
  name = 'RunStopped';
  code: StopCode;
  constructor(message: string, code: StopCode) {
    super(message);
    this.code = code;
  }
}

// The dashboard server has nobody watching its terminal, so a security check stops the run instead of
// waiting for Enter.
let canPause = true;
export function disableManualPauses(): void {
  canPause = false;
}

function onNaukriPath(url: string | URL, prefix: string): boolean {
  const { hostname, pathname } = typeof url === 'string' ? new URL(url) : url;
  return hostname.endsWith('naukri.com') && pathname.startsWith(prefix);
}

export async function detectChallenge(page: Page): Promise<'BLOCKED' | 'CHALLENGE' | undefined> {
  const title = await page.title().catch(() => '');
  if (CHALLENGE_SELECTORS.blockedTitle.test(title.trim())) return 'BLOCKED';

  const selector = `${CHALLENGE_SELECTORS.frames}, ${CHALLENGE_SELECTORS.otpInput}`;
  if (await page.locator(selector).filter({ visible: true }).count()) return 'CHALLENGE';

  const text = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
  return CHALLENGE_SELECTORS.text.test(text) ? 'CHALLENGE' : undefined;
}

export const SESSION_MESSAGES: Record<SessionState, string> = {
  LOGGED_IN: 'Naukri session detected',
  LOGGED_OUT: 'Not logged in to Naukri. Log in first (`npm run login`, or Start Login on the dashboard).',
  CHALLENGE: 'PAUSED: Naukri is showing a CAPTCHA/OTP check. Complete it yourself in Chrome, then retry.',
  BLOCKED: BLOCKED_MESSAGE,
};

export async function checkSession(page: Page, { settleMs = 10_000 } = {}): Promise<SessionState> {
  await page.goto(NAUKRI_URLS.loggedInHome, { waitUntil: 'domcontentloaded' });
  const challenge = await detectChallenge(page);
  if (challenge) return challenge;

  // Naukri renders this URL for everyone and only redirects anonymous users after `load`,
  // so the URL alone right after navigation says nothing.
  const settled = await Promise.any([
    page
      .waitForURL((url) => onNaukriPath(url, NAUKRI_PATHS.login), { timeout: settleMs, waitUntil: 'commit' })
      .then(() => 'LOGGED_OUT' as const),
    page
      .locator(SESSION_SELECTORS.loggedInMarker)
      .first()
      .waitFor({ state: 'attached', timeout: settleMs })
      .then(() => 'LOGGED_IN' as const),
  ]).catch(() => undefined);
  if (settled) return settled;

  // No redirect within the settle window: Naukri accepted the session even if the marker selector drifted.
  const lateChallenge = await detectChallenge(page);
  if (lateChallenge) return lateChallenge;
  const onLoggedInPage = onNaukriPath(page.url(), NAUKRI_PATHS.loggedInArea);
  const loginFormVisible = await page.locator(SESSION_SELECTORS.loginForm).isVisible();
  return onLoggedInPage && !loginFormVisible ? 'LOGGED_IN' : 'LOGGED_OUT';
}

// Ends a run before it starts when the saved session can't be used.
export async function requireSession(page: Page): Promise<void> {
  const state = await checkSession(page);
  if (state === 'LOGGED_IN') {
    log.info(SESSION_MESSAGES.LOGGED_IN);
    return;
  }
  const codes = { LOGGED_OUT: 'SESSION_EXPIRED', CHALLENGE: 'SECURITY_CHALLENGE', BLOCKED: 'ACCESS_DENIED' } as const;
  throw new RunStopped(SESSION_MESSAGES[state], codes[state]);
}

// Resolves true when the user presses Enter, false on timeout or when nobody can answer.
export async function pauseForUser(message: string, timeoutMs = LOGIN_TIMEOUT_MS): Promise<boolean> {
  log.warn(message);
  if (!canPause || !process.stdin.isTTY) return false;
  const input = createInterface({ input: process.stdin, terminal: false });
  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      input.once('line', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  } finally {
    input.close();
  }
}

// Run after every navigation during a run.
export async function assertUsable(page: Page): Promise<void> {
  let challenge = await detectChallenge(page);
  if (challenge === 'CHALLENGE') {
    await pauseForUser('PAUSED: manual action required. Complete the CAPTCHA/OTP check in Chrome, then press Enter.');
    challenge = await detectChallenge(page);
  }
  if (challenge === 'BLOCKED') throw new RunStopped(BLOCKED_MESSAGE, 'ACCESS_DENIED');
  if (challenge === 'CHALLENGE') {
    throw new RunStopped('Naukri is showing a security check (CAPTCHA/OTP). Complete it in Chrome yourself, then start again.', 'SECURITY_CHALLENGE');
  }
  if (onNaukriPath(page.url(), NAUKRI_PATHS.login)) {
    throw new RunStopped('Naukri logged this browser out. Log in again, then retry.', 'SESSION_EXPIRED');
  }
}

async function checkSessionInNewTab(context: BrowserContext): Promise<SessionState> {
  // A separate tab so an early Enter press doesn't navigate away from a half-finished OTP form.
  const tab = await context.newPage();
  try {
    return await checkSession(tab);
  } finally {
    await tab.close().catch(() => {});
  }
}

type LoginSignal = 'navigated' | 'enter' | 'closed' | 'timeout';

// Emits 'line' when the user asks for a re-check; a readline interface on stdin does this on Enter.
type Rechecks = Pick<EventEmitter, 'on' | 'off'>;

function nextLoginSignal(context: BrowserContext, page: Page, input: Rechecks, timeoutMs: number): Promise<LoginSignal> {
  return new Promise((resolve) => {
    const onNavigated = (frame: Frame) => {
      if (frame === page.mainFrame() && onNaukriPath(frame.url(), NAUKRI_PATHS.loggedInArea)) finish('navigated');
    };
    const onLine = () => finish('enter');
    const onClose = () => finish('closed');
    const timer = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs));

    function finish(signal: LoginSignal) {
      clearTimeout(timer);
      page.off('framenavigated', onNavigated);
      page.off('close', onClose);
      context.off('close', onClose);
      input.off('line', onLine);
      resolve(signal);
    }

    page.on('framenavigated', onNavigated);
    page.on('close', onClose);
    context.on('close', onClose);
    input.on('line', onLine);
  });
}

// Waits for the user to log in by hand. Credentials, OTP and CAPTCHA are entered by the user only.
export async function waitForManualLogin(
  context: BrowserContext,
  page: Page,
  { timeoutMs = LOGIN_TIMEOUT_MS, rechecks }: { timeoutMs?: number; rechecks?: Rechecks } = {},
): Promise<LoginResult> {
  // terminal:false keeps Ctrl+C a real SIGINT, which Playwright uses to close Chrome cleanly.
  const stdin = rechecks ? undefined : createInterface({ input: process.stdin, terminal: false });
  const input = rechecks ?? stdin!;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const signal = await nextLoginSignal(context, page, input, deadline - Date.now());
      if (signal === 'closed') return 'CLOSED';
      if (signal === 'timeout') return 'TIMED_OUT';

      const state = await checkSessionInNewTab(context);
      if (state === 'LOGGED_IN') return 'LOGGED_IN';
      const retry = rechecks ? 'check the session again' : 'press Enter';
      if (state === 'LOGGED_OUT') log.info(`Not logged in yet. Finish logging in, then ${retry}.`);
      else log.warn(`PAUSED: Naukri is showing a security check (${state}). Complete it in Chrome, then ${retry}.`);
    }
  } finally {
    stdin?.close();
  }
}
