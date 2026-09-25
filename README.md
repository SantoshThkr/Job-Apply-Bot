# Naukri Job Bot

A local Chrome automation tool that finds Naukri jobs, scores them against your profile, and pre-fills applications, **stopping before the final submit** so you review and apply yourself.

Everything runs on your machine. Your Naukri password is never stored or seen by the bot: you log in by hand in a real Chrome window, and Chrome keeps the session in `data/browser-profile/`.

> **Status:** Phases 1–2 are done: the Chrome session and manual login, then job search, extraction, de-duplication and local storage. AI matching and the application flow are not built yet.

## Requirements

- macOS (other platforms should work but aren't tested)
- Node.js 22.18 or newer. The bot runs its TypeScript directly on Node, so there's no build step.
- Google Chrome

## Setup

```bash
npm install
cp .env.example .env
cp config/profile.example.json config/profile.json
cp config/resume.example.json config/resume.json
cp config/searches.example.json config/searches.json
cp config/answers.example.json config/answers.json
```

Then edit the copies:

- Put your OpenAI key in `.env` (`OPENAI_API_KEY=YOUR_OPENAI_API_KEY`).
- Replace every `YOUR_…` value in `config/*.json`. The bot won't load a file that still contains one, so a template value can never end up in an application.
- Copy your resume PDF into `resume/` and set `resumePath` in `config/resume.json` (for example `./resume/YOUR_RESUME.pdf`).

`.env`, `config/*.json` (except the `*.example.json` templates) and `resume/` are git-ignored, so your details stay on your machine.

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

## Find jobs

```bash
npm run search                                       # every search in config/searches.json
npm run search -- --keyword "YOUR_KEYWORD"           # one keyword, using your profile's locations
npm run search -- --keyword "YOUR_KEYWORD" --location Remote
npm run status                                       # what's stored so far
```

For each keyword the bot runs one Naukri search across your cities, plus a separate search with Naukri's Remote filter if `Remote` is in your locations. Results are filtered to your `experienceYears`.

- **Paging:** it reads up to 3 pages per search. It stops a search early once a page has nothing new.
- **Descriptions:** it opens each new job's page to read the full description.
- **Limits:** a run stores at most `MAX_JOBS_PER_RUN` new jobs.
- **Pacing:** it waits a random `DELAY_MIN_MS`–`DELAY_MAX_MS` between page loads.

Jobs are stored in `data/jobs.db` (SQLite, git-ignored). The same job found by several searches is stored once. The bot matches on the Naukri job ID, then the job URL, then company, title and location together.

If Naukri shows a CAPTCHA or OTP check mid-run, the bot pauses until you complete it in Chrome and press Enter. If Naukri blocks the browser or logs you out, the run stops. The bot doesn't retry against a block.

## Configuration

| File | Purpose |
| --- | --- |
| `.env` | Runtime settings: headless mode, score threshold, delays, `STOP_BEFORE_SUBMIT` (default `true`). |
| `config/profile.json` | Target roles, skills, preferred locations, experience range. |
| `config/resume.json` | Resume file path and form answers such as notice period and expected salary. |
| `config/searches.json` | Search groups: keywords, plus locations (these default to the profile's preferred locations). |
| `config/answers.json` | Your answers to recurring application questions. An answer is used only when the question contains every phrase in its `match` list. |

All config is validated on load. A misspelled key, an out-of-range value or a leftover `YOUR_…` placeholder stops the run with a message that names the file and field.

## Development

```bash
npm test              # unit tests plus browser tests against mocked local pages (never the real site)
npm run typecheck
npm run scan-secrets  # checks every file git would commit for secrets and private files
```

`npm install` also turns on a pre-commit hook (`.githooks/pre-commit`) that refuses commits containing private files (`.env`, `data/`, personal config, resumes, databases, logs, traces) or obvious credentials (OpenAI keys, bearer tokens, JWTs, Naukri cookies). It only warns about email addresses and phone numbers, because those are sometimes legitimate. Check every warning before you commit.

Set `LOG_LEVEL=debug` for more detail. Logs are also written to `logs/`.

## Troubleshooting

- **"Naukri refused this browser (Access Denied)".** Naukri's edge network blocks headless Chrome, so keep `HEADLESS=false`. If it happens with a visible window, you've probably made too many requests; wait and try again later.
- **"Browser profile … is already in use".** Another bot run or its Chrome window is still open. Close it.
- **Google sign-in fails in the bot's window.** Google often refuses sign-in from automated browsers. Use Naukri's email/password or OTP login instead.
- **Using Playwright's Chromium instead of Chrome.** Set `BROWSER_CHANNEL=chromium` and run `npx playwright install chromium` once.
- **A search or job page fails.** The bot logs a warning, saves a screenshot to `data/debug/` and moves on. Screenshots can show your account, so they stay local and git-ignored. Page structure lives in `src/browser/selectors.ts`, so that one file is where to fix a Naukri layout change.
- **Starting over.** Delete `data/jobs.db*` to forget stored jobs. Your login in `data/browser-profile/` is unaffected.

## Security and limitations

- The bot never solves or bypasses CAPTCHA, OTP, MFA or anti-bot checks. When it sees one, it pauses for you.
- It does not hide that the browser is automated.
- `data/browser-profile/` holds your Naukri session cookies. Treat it like a password: it's git-ignored, and you shouldn't share it. Deleting it logs the bot out.
- If a real credential is ever committed, treat it as leaked even after deleting it. Revoke and rotate it, because it stays in git history.
