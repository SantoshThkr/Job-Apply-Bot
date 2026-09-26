import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstPage, launchBrowser } from '../src/browser/browser.ts';
import { checkSession, detectChallenge, waitForManualLogin } from '../src/browser/session.ts';

const channel = process.env.BROWSER_CHANNEL === 'chromium' ? 'chromium' : 'chrome';
const tempDirs: string[] = [];

function tempProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'naukri-bot-profile-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('persistent browser profile', () => {
  const server = createServer((req, res) => {
    if (req.url === '/set') res.setHeader('Set-Cookie', 'session=abc; Max-Age=3600; Path=/; HttpOnly');
    res.end(req.headers.cookie ?? '');
  });
  let origin = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it('keeps cookies across a close and relaunch', async () => {
    const profileDir = tempProfile();
    const first = await launchBrowser({ headless: true, channel, profileDir });
    await (await firstPage(first)).goto(`${origin}/set`);
    await first.close();

    const second = await launchBrowser({ headless: true, channel, profileDir });
    try {
      const page = await firstPage(second);
      await page.goto(`${origin}/check`);
      expect(await page.locator('body').innerText()).toBe('session=abc');
    } finally {
      await second.close();
    }
  });

  it('refuses to open a profile that another run is using', async () => {
    const profileDir = tempProfile();
    const first = await launchBrowser({ headless: true, channel, profileDir });
    try {
      await expect(launchBrowser({ headless: true, channel, profileDir })).rejects.toThrow(/already in use/);
    } finally {
      await first.close();
    }
  });
});

describe('Naukri session detection (mocked pages)', () => {
  let context: BrowserContext;

  beforeAll(async () => {
    context = await launchBrowser({ headless: true, channel, profileDir: tempProfile() });
  });
  afterAll(async () => {
    await context.close();
  });

  // Every naukri.com request is answered locally; nothing reaches the real site.
  async function serveNaukri(pages: Record<string, { status?: number; body: string }>) {
    await context.unrouteAll();
    await context.route('https://www.naukri.com/**', (route) => {
      const page = pages[new URL(route.request().url()).pathname];
      return route.fulfill({ status: page?.status ?? 404, contentType: 'text/html', body: page?.body ?? '' });
    });
  }

  async function sessionState(options?: { settleMs: number }) {
    const page = await context.newPage();
    try {
      return await checkSession(page, options);
    } finally {
      await page.close();
    }
  }

  it('reports LOGGED_OUT when Naukri redirects to login after load', async () => {
    await serveNaukri({
      '/mnjuser/homepage': {
        body: `<script>setTimeout(() => location.replace('/nlogin/login?URL=' + encodeURIComponent(location.href)), 300)</script>`,
      },
      '/nlogin/login': { body: '<input id="usernameField">' },
    });
    expect(await sessionState()).toBe('LOGGED_OUT');
  });

  it('reports LOGGED_IN when the profile link renders', async () => {
    await serveNaukri({ '/mnjuser/homepage': { body: '<a href="/mnjuser/profile">View profile</a>' } });
    expect(await sessionState()).toBe('LOGGED_IN');
  });

  it('falls back to LOGGED_IN when no redirect happens even without the marker', async () => {
    await serveNaukri({ '/mnjuser/homepage': { body: '<h1>Welcome back</h1>' } });
    expect(await sessionState({ settleMs: 500 })).toBe('LOGGED_IN');
  });

  it('reports BLOCKED on the Akamai Access Denied page', async () => {
    await serveNaukri({
      '/mnjuser/homepage': { status: 403, body: "<title>Access Denied</title><h1>Access Denied</h1>You don't have permission" },
    });
    expect(await sessionState()).toBe('BLOCKED');
  });

  it('reports CHALLENGE when a CAPTCHA is showing', async () => {
    await serveNaukri({
      '/mnjuser/homepage': { body: '<iframe src="https://www.naukri.com/recaptcha/api2/bframe?k=x" width="300" height="300"></iframe>' },
    });
    expect(await sessionState()).toBe('CHALLENGE');
  });

  it('finishes manual login once the page reaches the logged-in homepage', async () => {
    await serveNaukri({
      '/nlogin/login': { body: `<script>setTimeout(() => location.assign('/mnjuser/homepage'), 300)</script>` },
      '/mnjuser/homepage': { body: '<a href="/mnjuser/profile">View profile</a>' },
    });
    const page = await context.newPage();
    try {
      // The ?URL= query mentions /mnjuser/, which must not count as being logged in.
      await page.goto('https://www.naukri.com/nlogin/login?URL=https%3A%2F%2Fwww.naukri.com%2Fmnjuser%2Fhomepage');
      expect(await waitForManualLogin(context, page, { timeoutMs: 10_000 })).toBe('LOGGED_IN');
    } finally {
      await page.close();
    }
  });

  it('stops waiting for manual login at the timeout', async () => {
    await serveNaukri({ '/nlogin/login': { body: '<input id="usernameField">' } });
    const page = await context.newPage();
    try {
      await page.goto('https://www.naukri.com/nlogin/login');
      expect(await waitForManualLogin(context, page, { timeoutMs: 500 })).toBe('TIMED_OUT');
    } finally {
      await page.close();
    }
  });

  it('ignores invisible and hidden reCAPTCHA frames', async () => {
    await serveNaukri({});
    const page = await context.newPage();
    try {
      await page.setContent(`
        <iframe src="https://www.naukri.com/recaptcha/api2/anchor?size=invisible" width="256" height="60"></iframe>
        <div style="visibility:hidden"><iframe src="https://www.naukri.com/recaptcha/api2/bframe?k=x"></iframe></div>
        <p>Search jobs</p>`);
      expect(await detectChallenge(page)).toBeUndefined();
    } finally {
      await page.close();
    }
  });
});
