import { mkdirSync } from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { paths } from '../config.ts';
import { log } from '../logger.ts';

export async function launchBrowser({
  headless,
  channel,
  profileDir = paths.browserProfile,
}: {
  headless: boolean;
  channel: 'chrome' | 'chromium';
  profileDir?: string;
}): Promise<BrowserContext> {
  mkdirSync(profileDir, { recursive: true });

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: channel === 'chrome' ? 'chrome' : undefined,
      headless,
      // Use the real window size instead of Playwright's fixed 1280x720 viewport.
      viewport: null,
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
