import { mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { ROOT, paths, type Env } from '../config.ts';
import { log } from '../logger.ts';

export async function launchBrowser({
  headless,
  channel,
  profileDir = paths.browserProfile,
  handleSignals = true,
}: {
  headless: boolean;
  channel: 'chrome' | 'chromium';
  profileDir?: string;
  // False when the caller closes Chrome itself on Ctrl+C (the dashboard server stops runs first).
  handleSignals?: boolean;
}): Promise<BrowserContext> {
  mkdirSync(profileDir, { recursive: true });

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: channel === 'chrome' ? 'chrome' : undefined,
      headless,
      // Use the real window size instead of Playwright's fixed 1280x720 viewport.
      viewport: null,
      handleSIGINT: handleSignals,
      handleSIGTERM: handleSignals,
      handleSIGHUP: handleSignals,
    });
  } catch (err) {
    if (/ProcessSingleton|SingletonLock|already in use/i.test(String(err))) {
      throw new Error(`Browser profile ${profileDir} is already in use. Close the other bot window and retry.`);
    }
    throw err;
  }

  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(45_000);
  log.info(`Browser started (${channel}${headless ? ', headless' : ''})`);
  return context;
}

export async function firstPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? (await context.newPage());
}

// Spaces out page loads (DELAY_MIN_MS..DELAY_MAX_MS) so a run doesn't hammer Naukri.
// This is rate limiting, not a readiness wait; readiness always uses locators and responses.
export async function politePause(page: Page, env: Pick<Env, 'DELAY_MIN_MS' | 'DELAY_MAX_MS'>): Promise<void> {
  await page.waitForTimeout(env.DELAY_MIN_MS + Math.random() * (env.DELAY_MAX_MS - env.DELAY_MIN_MS));
}

// Screenshots can show account details; they stay in data/debug (git-ignored) and are never uploaded.
export async function saveDebugScreenshot(page: Page, label: string): Promise<void> {
  try {
    mkdirSync(paths.debug, { recursive: true });
    const file = join(paths.debug, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.png`);
    await page.screenshot({ path: file });
    log.info(`Screenshot saved: ${relative(ROOT, file)}`);
  } catch (err) {
    log.debug(`Could not save screenshot: ${(err as Error).message}`);
  }
}

// One screenshot per application step (DEBUG_SCREENSHOTS=true), grouped by run in data/debug/<run id>/.
export async function saveStepScreenshot(page: Page, runId: string, label: string): Promise<void> {
  try {
    const dir = join(paths.debug, runId);
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${label.replace(/[^\w.-]+/g, '-')}.png`) });
  } catch (err) {
    log.debug(`Could not save screenshot: ${(err as Error).message}`);
  }
}
