# Naukri Job Bot

A local Chrome automation tool that finds Naukri jobs, scores them against your profile, and pre-fills applications, **stopping before the final submit** so you review and apply yourself.

Everything runs on your machine. Your Naukri password is never stored or seen by the bot: you log in by hand in a real Chrome window, and Chrome keeps the session in `data/browser-profile/`.

> **Status:** Phase 1 is done: project setup, the Chrome session, and manual login. Job search, AI matching and the application flow are not built yet.

## Requirements

- macOS (other platforms should work but aren't tested)
- Node.js 22.18 or newer. The bot runs its TypeScript directly on Node, so there's no build step.
- Google Chrome

## Setup

```bash
npm install
cp .env.example .env
```

## Log in to Naukri (once)

```bash
npm run login
```

A Chrome window opens on the Naukri login page. Log in normally and complete any OTP or CAPTCHA yourself. When your Naukri homepage loads, the bot confirms the session, saves it and closes Chrome. If it doesn't notice (for example, Naukri sent you to a different page after login), press Enter in the terminal.

Check the saved session any time:

```bash
npm run session
```

It exits with code 0 when the session is valid and 1 otherwise.

## Configuration

| File | Purpose |
| --- | --- |
| `.env` | Runtime settings: headless mode, score threshold, delays, `STOP_BEFORE_SUBMIT` (default `true`). |
| `config/profile.json` | Target roles, skills, preferred locations, experience range. |
| `config/resume.json` | Resume file path and form answers such as notice period and expected salary. |
| `config/searches.json` | Search groups: keywords, plus locations (these default to the profile's preferred locations). |

All config is validated on load. A misspelled key or an out-of-range value stops the run with a message that names the file and field.

## Development

```bash
npm test          # unit tests plus browser tests against mocked local pages (never the real site)
npm run typecheck
```

Set `LOG_LEVEL=debug` for more detail. Logs are also written to `logs/`.

## Troubleshooting

- **"Naukri refused this browser (Access Denied)".** Naukri's edge network blocks headless Chrome, so keep `HEADLESS=false`. If it happens with a visible window, you've probably made too many requests; wait and try again later.
- **"Browser profile … is already in use".** Another bot run or its Chrome window is still open. Close it.
- **Google sign-in fails in the bot's window.** Google often refuses sign-in from automated browsers. Use Naukri's email/password or OTP login instead.
- **Using Playwright's Chromium instead of Chrome.** Set `BROWSER_CHANNEL=chromium` and run `npx playwright install chromium` once.

## Security and limitations

- The bot never solves or bypasses CAPTCHA, OTP, MFA or anti-bot checks. When it sees one, it pauses for you.
- It does not hide that the browser is automated.
- `data/browser-profile/` holds your Naukri session cookies. Treat it like a password: it's git-ignored, and you shouldn't share it. Deleting it logs the bot out.
