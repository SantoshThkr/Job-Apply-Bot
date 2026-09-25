import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { firstPage, launchBrowser } from './browser/browser.ts';
import { checkSession, waitForManualLogin, type SessionState } from './browser/session.ts';
import { ROOT, loadEnv } from './config.ts';
import { log } from './logger.ts';

const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const BLOCKED_HINT =
  'Naukri refused this browser (Access Denied). This happens with HEADLESS=true or after too many requests. ' +
  'Wait a while and retry with a visible browser; the bot will not try to get around it.';

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
    if (state === 'BLOCKED') throw new Error(BLOCKED_HINT);

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

const SESSION_MESSAGES: Record<SessionState, string> = {
  LOGGED_IN: 'Naukri session detected',
  LOGGED_OUT: 'Not logged in to Naukri. Run `npm run login`.',
  CHALLENGE: 'PAUSED: Naukri is showing a CAPTCHA/OTP check. Run `npm run login` and complete it manually.',
  BLOCKED: BLOCKED_HINT,
};

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

const commands: Record<string, () => Promise<void>> = { login, session };

const name = process.argv[2] ?? '';
const command = commands[name];
if (!command) {
  console.error(`Usage: node src/cli.ts <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}

try {
  await command();
} catch (err) {
  log.error(`${name} failed`, err);
  process.exitCode = 1;
}
