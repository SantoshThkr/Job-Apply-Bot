# Naukri Job Bot

A local Chrome automation tool that finds Naukri jobs for the kinds of role you pick, freshest first, scores them against your skills with a local AI model, and applies to the ones that match. It runs from the terminal or from a local web dashboard. **It sends nothing unless you turn on auto apply**, and it marks a job applied only when Naukri confirms it.

Everything runs on your machine. Your Naukri password is never stored or seen by the bot: you log in by hand in a real Chrome window, and Chrome keeps the session in `data/browser-profile/`.

> **Status:** session and login, job profiles, fresh-job search, local AI matching, the application engine and the dashboard are built. The Apply button, the company-site button, the external URL and Naukri's freshness filter were checked against live Naukri pages. Naukri's recruiter-question chat, its post-apply confirmation and any application form have not been seen by the bot yet (see [What is verified](#what-is-verified)), so start with one job.

## Requirements

- macOS (other platforms should work but aren't tested)
- Node.js 22.18 or newer. The bot runs its TypeScript directly on Node, so there's no build step.
- Google Chrome

## Setup

```bash
npm install
npm install --prefix web      # the dashboard; skip it if you only use the terminal
cp .env.example .env
cp config/profile.example.json config/profile.json
cp config/resume.example.json config/resume.json
cp config/answers.example.json config/answers.json
```

The seven job profiles in `config/job-profiles.example.json` work as they are; copy the file to `config/job-profiles.json` only to change them (see [Job profiles](#job-profiles)).

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

## Job profiles

A job profile is a kind of role to search for and apply to. Seven ship with the bot:

- Frontend Developer
- React.js Developer
- Angular Developer
- Web Developer
- Full Stack Developer
- Full Stack AI Engineer
- All / Broad Software & Web

Each one lists Naukri search keywords and the skills that make a job that kind of role:

```json
{
  "id": "angular",
  "name": "Angular Developer",
  "keywords": ["Angular Developer"],
  "skills": ["Angular", "RxJS", "NgRx"],
  "exclude": [],
  "ai": false
}
```

A job belongs to every profile whose keywords or skills its title names. For example, "Senior React Developer" belongs to Frontend, React.js and Broad.

- **Generic titles:** a title like "Software Engineer" says nothing on its own, so the job's listed skills decide instead (two or more of the profile's skills).
- **`exclude`:** keeps a profile away from unrelated stacks. The broad profile excludes Java, .NET, DevOps, data engineering and similar titles.
- **`ai: true`:** marks the one profile where how central AI work is counts towards the score.
- **Changing profiles:** copy the file to `config/job-profiles.json` and edit or add profiles there; no code changes are needed. Jobs are re-sorted into profiles at the start of every run.

## Find jobs

```bash
npm run search                                       # every profile
npm run search -- --profile react,angular            # some profiles (ids from job-profiles)
npm run search -- --profile react --fresh 24h        # only jobs posted in the last 24 hours
npm run search -- --keyword "YOUR_KEYWORD"           # one keyword, using your locations
npm run search -- --keyword "YOUR_KEYWORD" --location Remote
npm run status                                       # what's stored so far
```

For each profile keyword the bot runs one Naukri search across your cities, plus a separate search with Naukri's Remote filter if `Remote` is in your locations.

- **No experience filter:** jobs asking for any experience (0–2, 5–10, 10+) are found and kept. Experience is shown with the job and plays no part in filtering, scoring or applying.
- **Freshness:** `--fresh` takes `today`, `24h`, `3d`, `7d` or `all` (the default). The bot passes Naukri's own freshness filter, which is approximate, then checks the exact posting time itself. Naukri gives posting times to the second.
- **Keywords with a dot:** Naukri silently drops the freshness and Remote filters when the keyword has a dot, so "React.js" is searched as "React js". If Naukri still drops a filter, that page of results is skipped with a warning rather than stored.
- **Paging:** it reads up to `SEARCH_MAX_PAGES` pages per search (default 10). It stops a search early once a page has nothing new.
- **Descriptions:** it opens each new job in the chosen profiles and freshness to read the full description, and records the company-site address for jobs that apply outside Naukri.
- **Limits:** none by default. Set `MAX_JOBS_PER_RUN` if you want a cap on new jobs per search.
- **Pacing:** it waits a random `DELAY_MIN_MS`–`DELAY_MAX_MS` between page loads.

Jobs are stored in `data/jobs.db` (SQLite, git-ignored). The same job found by several searches is stored once. The bot matches on the Naukri job ID, then the job URL, then company, title and location together.

If Naukri shows a CAPTCHA or OTP check mid-run, the terminal pauses until you complete it in Chrome and press Enter; the dashboard stops the run instead. If Naukri blocks the browser or logs you out, the run stops. The bot doesn't retry against a block.

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
   ollama pull qwen3:4b
   ```
4. Confirm it's installed:
   ```bash
   ollama list
   ```

**Choosing a model.** `qwen3:4b` (the default) is a 2.5 GB download and needs about 3.5 GB of free RAM while running. With more disk and RAM, `qwen3:8b` (5.2 GB, about 6 GB of RAM) is more careful; set `OLLAMA_MODEL=qwen3:8b` in `.env`. Any model you've pulled works; no code changes are needed.

**Use the native app, not Docker.** On a Mac, Ollama in Docker can't use the GPU and is limited to Docker's memory allowance, so it's much slower and may fail to load an 8B model. If Ollama runs somewhere else, point `OLLAMA_BASE_URL` at it.

### Run it

```bash
npm run analyze            # score jobs that have a description and haven't been scored
npm run analyze -- --force # re-score everything, including failed jobs; e.g. after editing your profile
npm run dry-run            # search, then analyze, then print results; never opens an application
```

Before any job is processed, `analyze` checks that Ollama is reachable and that the model is installed. If either check fails, it stops and tells you exactly what to do. It shows progress per job, then a summary: jobs analyzed, successes, failures, cache hits and misses, and average time per job. Expect 15 to 50 seconds per job with `qwen3:4b` on an M2. `AI_CONCURRENCY` defaults to 1 so the Mac stays usable.

### How matching works

1. **Filter on listing data (no AI).** A job is dropped if its title matches none of your job profiles, or if none of its locations are in your preferred list (remote jobs always pass). Experience is never checked. Filtered jobs are marked `SKIPPED` with the reason, and are checked again on every run, so edited profiles take effect at once.
2. **Local model evidence.** For the remaining jobs, the model reports structured evidence:
   - required, preferred and optional skills
   - how closely the role matches the job's profiles
   - how central AI work is
   - the stated minimum experience (shown only)
   - other requirements, and red flags

   The model never sees your years of experience, and experience isn't treated as a requirement, so it can't count against a job. The prompt lives in `src/ai/prompts/job-match.v3.md`.
   - Output is cleaned of markdown fences and extra text, parsed, and validated against a schema. If it fails, the bot retries up to `AI_MAX_ATTEMPTS` times, then marks the job `ANALYSIS_FAILED` and carries on with the others.
   - Evidence is never made up: if required fields are missing, the attempt fails.
3. **Skill coverage is decided in code, not by the model.** A job skill counts as yours only if it is one of your profile skills, a spelling variant ("React.js" and "React"), a built-in alias ("Large Language Models" and "LLM", see `src/jobs/skills.ts`), or an alias you configure in `config/profile.json`:
   ```json
   "skillAliases": { "Node.js": ["Express"] }
   ```
   A model claiming "LangGraph is covered by Python" changes nothing. The model's skill lists are checked against the posting too: a skill counts, as matched or missing, only if the job's title, description or Naukri key skills name it (in any of the spellings and aliases above; a longer phrase counts when each of its words is there). A small model sometimes pads the lists with your own skills; those are dropped.
4. **The score is calculated in code:**

| Component | Weight |
| --- | --- |
| Role relevance | 30% |
| Required skills (80%) and preferred skills (20%) | 35% |
| AI/LLM focus (only for an `ai` profile) | 20% |
| Location | 10% |
| Other stated requirements | 5% |

For a job whose profiles aren't about AI, the AI share drops out and the other weights are scaled up to 100%. A job in both kinds of profile gets the better of the two scores.

- **Bands:** a score of 90 or more is a HIGH MATCH, and 75–89 is a MATCH.
- **Status:** jobs at or above `MIN_MATCH_SCORE` are `SHORTLISTED`, 60 up to that score are `REVIEW`, and anything lower is `SKIPPED`.
- **Holds:** a job that scores high enough but sits outside your locations is held at `REVIEW` with the reason shown.
- **Red flags** are reported but don't change the score.

**Caching:** evidence is cached by provider, model, prompt version, profile and job description. Re-runs, `--force`, and reposts with an identical description reuse it instead of running the model again. Switching model or provider never reuses another model's results.

**Privacy:** the model receives the job posting, the names of the job's profiles, and your skills and preferred locations. Your name, experience, contact details, resume, Naukri session and cookies are never sent.

**Optional: OpenAI instead of Ollama.** Set `AI_PROVIDER=openai`, `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in `.env`. This is paid and sends the same data to OpenAI. In the default Ollama mode, no OpenAI request is ever made and no key is needed.

## Apply to jobs

```bash
npm run apply                               # every eligible job, freshest first; clicks nothing
npm run apply -- --profile react --fresh 3d # only those profiles and that freshness
npm run apply -- --max 1 --auto-apply       # really apply to one job (same as AUTO_APPLY=true, for one job)
npm run apply -- --auto-apply               # really apply to the whole queue
npm run apply -- --min-score 85
npm run report                              # the latest application run's report again
npm run report -- RUN-20260925-233612
```

**The queue** is every job in the chosen profiles and freshness that matching `SHORTLISTED` at or above the minimum score, freshest first. There is no cap: a run works through the whole queue until it's done, you pause or stop it, or Naukri makes it unsafe to go on. `--max` is only for trying one or two jobs.

**Left out of the queue:**

- jobs already applied to, by the bot or by you
- jobs that apply on the company's own site
- jobs that may have been sent already without a confirmation (check them on Naukri yourself)
- jobs waiting on an answer you haven't configured (they come back once `config/answers.json` or your profile has one)
- jobs that failed three times, and postings that are gone

For each job the bot does the following, and records every step in `data/jobs.db`:

1. Checks the database again for an earlier successful application.
2. Opens the job and reads which button Naukri shows:
   - "Applied": recorded as `ALREADY_APPLIED`.
   - "Apply on company site": recorded as `EXTERNAL`, with the site's address from Naukri's job data. The bot never goes there.
   - No button: recorded as `FAILED` with the reason.
3. **With auto apply off (the default) it stops here** and records `READY_TO_APPLY`. On Naukri, clicking Apply sends the application for any job without recruiter questions, and in the question chat the last answer sends it. So an "apply but don't submit" mode can't be done safely for Naukri's own flows; auto apply is the one switch that allows sending.
4. With auto apply on, it clicks Apply once (`APPLY_CLICKED`):
   - **Recruiter questions** (`FORM_OPENED`): each question is answered only from `config/answers.json`, or from your profile and resume. Those cover name, email, phone, current location, total experience, notice period, current role, skills and expected salary, using patterns that can't catch a different question ("years of React experience" is not your total experience). For a choice question it picks only an option that says exactly the same thing.
   - **An application form with its own Submit button:** the same rules fill every known field (`FORM_FILLED`). The bot submits (`SUBMIT_CLICKED`) only once every required field has a value. If the run is stopped at that point, the form is left filled and unsent as `READY_TO_SUBMIT`.
   - **Anything it can't answer safely** (an unknown required question, an answer that isn't among the options, an unsupported field) makes the job `NEEDS_REVIEW`. The question is saved, nothing is submitted, and the run moves on.
5. **Verification.** The job is `APPLIED` only on evidence from Naukri: its "successfully applied" message or confirmation page, or the job page showing "Applied" after a reload. An error message from Naukri makes it `FAILED`. No evidence either way makes it `NEEDS_REVIEW` (reason `SUBMIT_UNVERIFIED`); such a job is never clicked again automatically.

A job that fails doesn't stop the run. The run stops, and says why, when:

- Naukri shows a CAPTCHA or OTP check (`SECURITY_CHALLENGE`), blocks the browser, or logs you out. Log in again from the dashboard, then start again; the queue picks up where it left off.
- The browser window is closed.
- 3 applications in a row go unconfirmed, which usually means Naukri's pages changed.

**Pause, resume and stop** (dashboard):

- **Pause:** the bot finishes the step it is on, then waits at the next point where nothing is half done, before any click that could send something. The browser stays open.
- **Resume:** it carries on from there.
- **Stop:** the same safe point, but the run is saved as `STOPPED`. The bot never submits because a stop or pause was requested.
- **Ctrl+C in the terminal:** the same as Stop: the job in hand is finished and recorded, then Chrome closes. A second Ctrl+C quits at once; the run is then closed as `FAILED` the next time the bot starts, and a job left mid-apply becomes `NEEDS_REVIEW` if Apply had been clicked.

### Statuses

The dashboard shows each job in one of these, and keeps the exact state and reason for the details view:

| Shown as | Exact states | Meaning |
| --- | --- | --- |
| Ready to apply | `READY_TO_APPLY`, `READY_TO_SUBMIT` | Found an internal Apply button and stopped before it, or filled a form and stopped before submitting. |
| Applying | `APPLYING`, `APPLY_CLICKED`, `FORM_OPENED`, `FORM_FILLED`, `SUBMIT_CLICKED` | The bot is on this job right now. |
| Applied | `APPLIED` | Naukri confirmed the application. |
| Failed | `FAILED`, `SECURITY_CHALLENGE` | Didn't go through, with the reason (Naukri's error, no Apply button, a page that wouldn't load, a security check). Retried up to three times. |
| External | `EXTERNAL` | Applies on the company's site; not automated. |
| Review | `NEEDS_REVIEW` | A question or field it can't answer safely, or sent without a confirmation. Nothing is guessed. |
| Already applied | `ALREADY_APPLIED` | Applied earlier, in the database or on Naukri. |

Each attempt also records separately whether the Apply button was found, Apply was clicked, a form opened, it was filled, it was submitted, and success was confirmed.

### What is verified

- **Checked against live Naukri pages:**
  - the Apply button (`#apply-button`) and the company-site button (`#company-site-button`)
  - the external URL in Naukri's job data
  - the freshness filter (`jobAge`), and that Naukri drops it for a keyword with a dot
- **Seen once:** the "Applied" label that replaces Apply. The check matched on one live job, which was recorded as `ALREADY_APPLIED`.
- **Not yet seen by the bot:**
  - the recruiter-question chat
  - Naukri's post-apply confirmation
  - any separate application form

  Their selectors in `src/browser/selectors.ts` are marked as such. If they're wrong, the bot fails safe: jobs end as `NEEDS_REVIEW`, never as a false `APPLIED`.
- **Rolling out:** go one step at a time and check the result in the dashboard (History) or with `npm run report` after each:
  1. `npm run apply -- --max 1` (nothing is sent)
  2. `npm run apply -- --max 1 --auto-apply`
  3. two jobs
  4. a small batch
  5. the whole queue

  With `DEBUG_SCREENSHOTS=true`, each step is also saved to `data/debug/<run id>/`.

## Dashboard

A small local control panel for everything above. It uses the same code as the terminal commands.

```bash
npm run server   # the bot's local API on 127.0.0.1:4100; it owns the Chrome window
npm run web      # the dashboard on http://127.0.0.1:3000 (second terminal)
```

- **Dashboard:**
  - Naukri, browser and AI status, with Log in and Check. You log in and handle any OTP or CAPTCHA yourself in Chrome.
  - jobs found, fresh jobs, applied and failed
  - the current run, step by step
- **Jobs:**
  - pick profiles and how fresh, then Search: the bot searches Naukri, reads the new jobs and scores them with the local AI
  - the job table (company, job, location, posted, match, status), with jobs still to act on first and the newest first. A job opens its AI evidence and application history.
- **Apply:**
  - the same choice of profiles and freshness
  - how many jobs are ready to apply, applying, applied, failed, external, in review and already applied
  - Auto apply, which asks for confirmation when you turn it on
  - Start, Pause, Resume and Stop
  - the current job, step by step, and this run's results with the exact reason for each job
- **History:** every application run (jobs, applied, failed, review, external). A run opens its results.

The dashboard gets live updates over Server-Sent Events and reconnects by itself. Everything it shows comes from `data/jobs.db` or from the running bot. Your choice of profiles and freshness is remembered in the browser; nothing else is stored there. The API accepts requests from this machine only: it binds to 127.0.0.1, rejects other hosts and cross-site origins, and only takes JSON. There is no login and nothing is sent anywhere else.

While `npm run server` is running it holds the Chrome profile, so the terminal commands that open Chrome (`login`, `session`, `search`, `apply`) will say the profile is in use. `analyze`, `status` and `report` still work. Stop the server with Ctrl+C: it lets an active run reach a safe point first, and a second Ctrl+C quits at once.

## Configuration

| File | Purpose |
| --- | --- |
| `.env` | Runtime settings: AI provider and model, headless mode, score threshold, search depth, delays, `AUTO_APPLY` (default `false`), debug screenshots, API port. |
| `config/profile.json` | Your name, skills, preferred locations and total experience. Experience is only used to fill forms; it never filters jobs. Older files with `targetRoles` or `minimumExperience`/`maximumExperience` still load; those fields are ignored. |
| `config/job-profiles.json` | Optional: your own job profiles. Without it the seven in `job-profiles.example.json` are used. |
| `config/resume.json` | Resume file path, and what application forms ask: email, phone, current title and location, notice period, expected salary. |
| `config/answers.json` | Your answers to recruiter questions. An answer is used only when the question contains every phrase in its `match` list. When several match, the one with more words wins, and a tie means no answer. It takes precedence over your profile and resume details. |

All config is validated on load. A misspelled key, an out-of-range value or a leftover `YOUR_…` placeholder stops the run with a message that names the file and field.

## Development

```bash
npm test              # bot and dashboard tests; browser tests use fake local pages, never the real site
npm run typecheck
npm --prefix web run typecheck
npm --prefix web run build
npm run scan-secrets  # checks every file git would commit for secrets and private files
```

`npm install` also turns on a pre-commit hook (`.githooks/pre-commit`) that refuses commits containing private files (`.env`, `data/`, personal config, resumes, databases, logs, traces) or obvious credentials (OpenAI keys, bearer tokens, JWTs, Naukri cookies). It only warns about email addresses and phone numbers, because those are sometimes legitimate. Check every warning before you commit.

Set `LOG_LEVEL=debug` for more detail. Logs are also written to `logs/`.

## Troubleshooting

- **"Naukri refused this browser (Access Denied)".** Naukri's edge network blocks headless Chrome, so keep `HEADLESS=false`. If it happens with a visible window, you've probably made too many requests; wait and try again later.
- **"Browser profile … is already in use".** Another bot run, its Chrome window, or `npm run server` is still open. Close it, or use the dashboard.
- **"Port 4100 is in use".** Another `npm run server` is running. Stop it, or set `API_PORT` in `.env`.
- **The dashboard says "Not connected to the bot server".** Start `npm run server`; the dashboard reconnects on its own.
- **Database backups.** Before a schema change, the bot copies the database to `data/backups/`.
- **Google sign-in fails in the bot's window.** Google often refuses sign-in from automated browsers. Use Naukri's email/password or OTP login instead.
- **Using Playwright's Chromium instead of Chrome.** Set `BROWSER_CHANNEL=chromium` and run `npx playwright install chromium` once.
- **A search or job page fails.** The bot logs a warning, saves a screenshot to `data/debug/` and moves on. Screenshots can show your account, so they stay local and git-ignored. Page structure lives in `src/browser/selectors.ts`, so that one file is where to fix a Naukri layout change.
- **Starting over.** Delete `data/jobs.db*` to forget stored jobs. Your login in `data/browser-profile/` is unaffected.
- **A good job was filtered out.** Run `npm run status` to see what was filtered. If its title wasn't covered, add a keyword or skill to a profile in `config/job-profiles.json`; filtered jobs are checked again on the next run.
- **`config/searches.json` from an earlier version.** It isn't read any more. Move its keywords into a profile in `config/job-profiles.json`.
- **"Ollama is not running".** Start the Ollama app, or check `OLLAMA_BASE_URL`.
- **"The configured model … is not installed".** Run `ollama pull <model>` or set `OLLAMA_MODEL` to a model shown by `ollama list`.
- **Many jobs end in `ANALYSIS_FAILED`.** The model is struggling to produce valid output. Try a larger model, or raise `AI_MAX_ATTEMPTS`, then run `npm run analyze -- --force`.
- **Analysis is very slow.** Use the native Ollama app rather than Docker, try `qwen3:4b`, and keep `AI_CONCURRENCY=1`.

## Security and limitations

- The bot never solves or bypasses CAPTCHA, OTP, MFA or anti-bot checks. In the terminal it pauses for you; from the dashboard the run stops with `SECURITY_CHALLENGE`.
- It never answers a question from anything but your config, never continues on a company's own site, and never reports an application as applied without Naukri's confirmation.
- It does not hide that the browser is automated.
- `data/browser-profile/` holds your Naukri session cookies. Treat it like a password: it's git-ignored, and you shouldn't share it. Deleting it logs the bot out.
- If a real credential is ever committed, treat it as leaked even after deleting it. Revoke and rotate it, because it stays in git history.
