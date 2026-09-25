# Naukri Job Bot

A local Chrome automation tool that finds Naukri jobs, scores them against your profile, and pre-fills applications, **stopping before the final submit** so you review and apply yourself.

Everything runs on your machine. Your Naukri password is never stored or seen by the bot: you log in by hand in a real Chrome window, and Chrome keeps the session in `data/browser-profile/`.

> **Status:** Phases 1–3 are done: the Chrome session and manual login; job search, extraction, de-duplication and storage; and local AI matching (Ollama) with deterministic scoring. The application flow is not built yet.

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

- Install Ollama and a model (see [Score jobs](#score-jobs)). No API key is needed.
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

## Score jobs

Job matching runs on a free local model through [Ollama](https://ollama.com). There's no API cost, and the job descriptions and your profile only travel to `localhost`.

### Set up Ollama (once)

1. Install Ollama from https://ollama.com/download and start it. The bot never installs it for you.
2. Check it's running:
   ```bash
   ollama --version
   ```
3. Download a model. The bot never downloads models itself:
   ```bash
   ollama pull qwen3:8b
   ```
4. Confirm it's installed:
   ```bash
   ollama list
   ```

**Choosing a model.** `qwen3:8b` (the default) is a 5.2 GB download and needs about 6 GB of free RAM while running, which suits a 16 GB Mac. On an 8 GB Mac, or when disk space is tight, use `qwen3:4b` (2.5 GB) and set `OLLAMA_MODEL=qwen3:4b` in `.env`. Any model you've pulled works; no code changes are needed.

**Use the native app, not Docker.** On a Mac, Ollama in Docker can't use the GPU and is limited to Docker's memory allowance, so it's much slower and may fail to load an 8B model. If Ollama runs somewhere else, point `OLLAMA_BASE_URL` at it.

### Run it

```bash
npm run analyze            # score jobs that have a description and haven't been scored
npm run analyze -- --force # re-score everything, including failed jobs; e.g. after editing your profile
npm run dry-run            # search, then analyze, then print results; never opens an application
```

Before any job is processed, `analyze` checks that Ollama is reachable and that the model is installed. If either check fails, it stops and tells you exactly what to do. It shows progress per job, then a summary: jobs analyzed, successes, failures, cache hits and misses, and average time per job. Expect tens of seconds per job with an 8B model. `AI_CONCURRENCY` defaults to 1 so the Mac stays usable.

### How matching works

1. **Filter on listing data (no AI).** A job is dropped if its experience range is outside your `minimumExperience`–`maximumExperience`, if none of its locations are in your preferred list (remote jobs always pass), or if its title matches none of your target roles or skills. Filtered jobs are marked `SKIPPED` with the reason. `npm run search` runs this filter before reading descriptions, so rejected jobs never cost a page load.
2. **Local model evidence.** For the remaining jobs, the model reports structured evidence: required, preferred and optional skills; how closely the role matches; how central AI work is; the stated minimum experience; other requirements; and red flags. The prompt lives in `src/ai/prompts/job-match.v2.md`.
   - Output is cleaned of markdown fences and extra text, parsed, and validated against a schema. If it fails, the bot retries up to `AI_MAX_ATTEMPTS` times, then marks the job `ANALYSIS_FAILED` and carries on with the others.
   - Evidence is never made up: if required fields are missing, the attempt fails.
3. **Skill coverage is decided in code, not by the model.** A job skill counts as yours only if it is one of your profile skills, a spelling variant ("React.js" and "React"), a built-in alias ("Large Language Models" and "LLM", see `src/jobs/skills.ts`), or an alias you configure in `config/profile.json`:
   ```json
   "skillAliases": { "Node.js": ["Express"] }
   ```
   A model claiming "LangGraph is covered by Python" changes nothing.
4. **The score is calculated in code:**

| Component | Weight |
| --- | --- |
| Role relevance | 25% |
| Required skills (80%) and preferred skills (20%) | 30% |
| AI/LLM focus | 20% |
| Experience fit | 10% |
| Location | 10% |
| Other stated requirements | 5% |

A score of 90 or more is a HIGH MATCH, and 75–89 is a MATCH. Jobs at or above `MIN_MATCH_SCORE` are `SHORTLISTED`, 60 up to that score are `REVIEW`, and anything lower is `SKIPPED`. A job that scores high enough but needs 2 or more years beyond your experience, or sits outside your locations, is held at `REVIEW` with the reason shown. Red flags are reported but don't change the score.

**Caching:** evidence is cached by provider, model, prompt version, profile and job description. Re-runs, `--force`, and reposts with an identical description reuse it instead of running the model again. Switching model or provider never reuses another model's results.

**Privacy:** the model receives the job posting and your professional profile (experience, target roles, skills, preferred locations). Your name, contact details, resume, Naukri session and cookies are never sent.

**Optional: OpenAI instead of Ollama.** Set `AI_PROVIDER=openai`, `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in `.env`. This is paid and sends the same data to OpenAI. In the default Ollama mode, no OpenAI request is ever made and no key is needed.

## Configuration

| File | Purpose |
| --- | --- |
| `.env` | Runtime settings: AI provider and model, headless mode, score threshold, delays, `STOP_BEFORE_SUBMIT` (default `true`). |
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
- **A good job was filtered out.** Run `npm run status` to see what was filtered. If the filter was too strict, add the role or skill to `config/profile.json` and run `npm run analyze -- --force`, which re-checks previously filtered jobs.
- **"Ollama is not running".** Start the Ollama app, or check `OLLAMA_BASE_URL`.
- **"The configured model … is not installed".** Run `ollama pull <model>` or set `OLLAMA_MODEL` to a model shown by `ollama list`.
- **Many jobs end in `ANALYSIS_FAILED`.** The model is struggling to produce valid output. Try a larger model, or raise `AI_MAX_ATTEMPTS`, then run `npm run analyze -- --force`.
- **Analysis is very slow.** Use the native Ollama app rather than Docker, try `qwen3:4b`, and keep `AI_CONCURRENCY=1`.

## Security and limitations

- The bot never solves or bypasses CAPTCHA, OTP, MFA or anti-bot checks. When it sees one, it pauses for you.
- It does not hide that the browser is automated.
- `data/browser-profile/` holds your Naukri session cookies. Treat it like a password: it's git-ignored, and you shouldn't share it. Deleting it logs the bot out.
- If a real credential is ever committed, treat it as leaked even after deleting it. Revoke and rotate it, because it stays in git history.
