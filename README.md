# Naukri Job Bot

A local tool that searches Naukri for fresh jobs of the kinds you pick, checks which ones you are eligible for, and applies to them one after another in a real Chrome window. You set it up once in a local web dashboard, press **Start auto apply**, and watch it work. It marks a job applied only when Naukri confirms it.

Everything runs on your machine. Your Naukri password is never stored or seen by the bot: you log in by hand in Chrome, and Chrome keeps the session in `data/browser-profile/`.

> **Status:** search, eligibility, the application engine and the dashboard are built and tested against fake Naukri pages. The Apply button, the company-site button, the external URL and Naukri's freshness filter were checked on live pages. Naukri's recruiter-question chat, its post-apply confirmation and separate application forms have not been seen by the bot yet (see [What is verified](#what-is-verified)), so start with one job.

## Requirements

- macOS (other platforms should work but aren't tested)
- Node.js 22.18 or newer. The bot runs its TypeScript directly on Node, so there's no build step.
- Google Chrome
- Optional: [Ollama](https://ollama.com) with `qwen3:4b`, for AI match scores (see [AI matching](#ai-matching))

## Setup

```bash
npm install
npm install --prefix web
cp .env.example .env
```

Start the bot and the dashboard, each in its own terminal:

```bash
npm run server   # the bot's local API on 127.0.0.1:4100; it owns the Chrome window
npm run web      # the dashboard on http://127.0.0.1:3000
```

Then, in the dashboard at http://127.0.0.1:3000:

1. **Profile:** fill in your details, skills, experience and notice period, upload your resume, and add answers to common recruiter questions. Save.
2. **Dashboard:** click **Log in**. Chrome opens Naukri; log in yourself and complete any OTP or CAPTCHA there. The session is saved for later runs.
3. **Apply:** pick job profiles, locations, how fresh, your experience and tolerance, and turn **Auto apply** on when you want applications sent. Press **Start auto apply**.

No source code or config file needs editing. Everything personal is saved in `data/`, which git ignores.

## What a run does

**Start auto apply** runs these steps with no further input:

1. **Search Naukri** for every keyword of the chosen job profiles, in the chosen locations, with Naukri's freshness filter. New jobs are stored and show up on the Jobs page as each results page arrives.
2. **Sort** each job into the job profiles its title names. Unrelated jobs (a Java-only role for a React profile) never go further.
3. **Check eligibility** from the listing: experience, location and posting time.
4. **Build the queue:** every eligible job on Naukri itself, newest first. Jobs applied to already, company-site jobs, and jobs waiting for you (see below) are left out.
5. **Apply to each job in turn:** open it, click Apply, fill known fields, answer known questions, submit when it is safe, and check Naukri's confirmation. Then the next job.

There is no cap: 10 eligible jobs means 10 applications, 1,000 means 1,000. A run ends when the queue is done, you press Stop, or Naukri makes it unsafe to go on.

### Job profiles

Seven ship with the bot, and you can pick one or several:

- Frontend Developer
- React.js Developer
- Angular Developer
- Web Developer
- Full Stack Developer
- Full Stack AI Engineer
- All / Broad Software & Web

Each lists Naukri search keywords and the skills that make a job that kind of role:

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

A job belongs to every profile whose keywords or skills its title names: "Senior React Developer" belongs to Frontend, React.js and Broad.

- **Generic titles** like "Software Engineer" belong to a profile when the job lists two or more of its skills.
- **`exclude`** keeps a profile away from unrelated stacks. The broad profile excludes Java, .NET, DevOps, data engineering and similar titles.
- **`ai: true`** marks the profile where how central AI work is counts towards the match score.
- **Changing them:** copy `config/job-profiles.example.json` to `config/job-profiles.json` and edit it. Jobs are re-sorted at the start of every run.

### Posting date

Today, 24 hours, 2 days, 3 days, 7 days, a custom range (from and to dates, both included), or any time. The bot passes Naukri's own filter, which is approximate and works in whole days (1, 3, 7, 15, 30), then checks each job's exact posting time itself. "Today" starts at local midnight. The queue always goes newest first.

Naukri silently drops the freshness and Remote filters when a keyword has a dot, so "React.js" is searched as "React js". If Naukri still drops a filter, that page of results is skipped with a warning rather than stored.

### Locations

The bot searches the chosen cities, plus Naukri's Remote filter when Remote is chosen. Remote jobs always count, whatever cities you pick, and "Delhi NCR" covers Delhi, Noida, Gurugram, Ghaziabad and Faridabad. The Profile page's preferred locations are the default.

### Experience

Experience decides eligibility, not what is searched. With 7 years and a tolerance of 6 months, a job whose minimum is up to 7.5 years is eligible:

| The job asks for | Eligible |
| --- | --- |
| 0–2, 3–7, 7–12 years | yes |
| 7.5–9 years | yes, within the tolerance |
| 8–10 years | no |
| 10+ years | no |

A job that states no experience is eligible. Jobs that aren't eligible stay on the Jobs page as **Not eligible** with the reason ("Requires 10+ years"); they are never applied to.

### Left out of the queue

- jobs applied to already, by the bot or by you
- jobs that apply on the company's own site
- jobs the AI has already scored below `MIN_MATCH_SCORE` (shown as Not eligible)
- jobs that may have been sent already without a confirmation. Check them on Naukri yourself.
- jobs waiting on an answer you haven't saved; they come back once the Profile page has one
- jobs that failed three times, and postings that are gone

### Applying to one job

Every step is recorded in `data/jobs.db`:

1. The database is checked again for an earlier successful application.
2. The job opens, and the bot reads which button Naukri shows:
   - "Applied": recorded as `ALREADY_APPLIED`.
   - "Apply on company site": recorded as `EXTERNAL`, with the company's address from Naukri's job data. The bot never goes there.
   - No button: `FAILED`, with the reason.
3. **With Auto apply off** it stops here and records `READY_TO_APPLY`. On Naukri, clicking Apply sends the application for any job without recruiter questions, and in the question chat the last answer sends it. So Auto apply is the one switch that allows sending.
4. **With Auto apply on** it clicks Apply once:
   - **Recruiter questions:** each is answered only from your saved answers or your profile: name, email, phone, current location, total experience, notice period, current role and company, salary and skills. The patterns can't catch a different question ("years of React experience" is not your total experience). For a choice, it picks only an option that says exactly the same thing.
   - **A form with its own Submit button:** the same rules fill every known field, and it is submitted only once every required field has a value.
   - **Anything it can't answer safely** (an unknown required question, an answer that isn't among the options, an unsupported field) ends as `NEEDS_REVIEW` with the question saved. Nothing is guessed or submitted, and the run moves on to the next job.
5. **Verification:** `APPLIED` only on Naukri's evidence: its "successfully applied" message or confirmation page, or the job page showing "Applied" after a reload. Naukri's error message makes it `FAILED`. No evidence either way makes it `NEEDS_REVIEW`, and such a job is never clicked again automatically.

A job that fails doesn't stop the run. The run stops, and says why, when:

- Naukri shows a CAPTCHA, OTP or other security check, blocks the browser, or logs you out. Log in again from the Dashboard and start again; the queue picks up where it left off. The bot never solves or bypasses these checks.
- The browser window is closed.
- Three applications in a row go unconfirmed, which usually means Naukri's pages changed.

**Pause** finishes the step in progress and waits before anything that could send an application. **Resume** carries on. **Stop** waits for the same safe point and saves the run as `STOPPED`; a stop or pause never causes a submit.

## Statuses

| Shown as | Exact states | Meaning |
| --- | --- | --- |
| Ready to apply | `READY_TO_APPLY`, `READY_TO_SUBMIT`, or not attempted yet | Eligible. With Auto apply off, the bot found the Apply button and stopped before it. |
| Applying | `APPLYING`, `APPLY_CLICKED`, `FORM_OPENED`, `FORM_FILLED`, `SUBMIT_CLICKED` | The bot is on this job right now. |
| Applied | `APPLIED` | Naukri confirmed the application. |
| Failed | `FAILED`, `SECURITY_CHALLENGE` | Didn't go through, with the reason. Retried up to three times. |
| Review | `NEEDS_REVIEW` | A question it can't answer safely, or sent without a confirmation. |
| External | `EXTERNAL` | Applies on the company's site; not automated. |
| Already applied | `ALREADY_APPLIED` | Applied earlier, in the database or on Naukri. |
| Not eligible | | Asks for more experience than you have plus the tolerance, or the AI scored it low. |

Finding the Apply button, clicking it and opening a form never count as applied. Each attempt records separately whether each of those happened and whether Naukri confirmed it.

## The dashboard

- **Dashboard:** Naukri, browser, AI and profile status, with Log in and Check; the counts for your current settings (fresh jobs, eligible, applied, review, failed, external); and the current run step by step, with Pause and Stop.
- **Jobs:** company, job, location, experience, posted, AI match and status, newest first, with the reason when a job is not eligible. A job opens its details, AI evidence and application history.
- **Apply:** the run settings, Auto apply, **Start auto apply**, the counts, the current job and the next one, Pause, Resume and Stop, and the latest results with the exact reason for each job.
- **History:** every run with its eligible, applied, review, failed and external counts. A run opens every job's result.
- **Profile:** your details, resume and saved answers.

Live updates come over Server-Sent Events, and the dashboard reconnects by itself. The run settings are remembered in this browser only. The API accepts requests from this machine only: it binds to 127.0.0.1, rejects other hosts and cross-site origins, and only takes JSON.

## Your data

| File | What it holds |
| --- | --- |
| `data/user-profile.json` | Your profile, written by the Profile page. `data/user-profile.example.json` shows the shape. |
| `data/answers.json` | Your saved answers. An answer is used when the question contains every phrase in its `match` list; when several match, the one naming more words wins, and a tie means no answer. `data/answers.example.json` shows the shape. |
| `data/resume/` | The resume you uploaded. |
| `data/browser-profile/` | Chrome's profile with your Naukri session. Treat it like a password. |
| `data/jobs.db` | Jobs, AI analyses, runs and every application step. Before a schema change, a copy goes to `data/backups/`. |

All of `data/` except the two templates is git-ignored, and `npm run scan-secrets` refuses to let any of it be committed. An older setup's `config/profile.json`, `config/resume.json` and `config/answers.json` are still read until you save the Profile page, which moves them into `data/` (the resume is copied too).

## AI matching

AI is a helper, not a gate. Searching and applying never wait for it. While a run applies, the bot scores eligible jobs in the background, one at a time, on a free local model through Ollama. It uses only descriptions it already has; opening a job to apply saves its description. A job is scored once, cached scores are reused, and unrelated jobs never reach the model. When the run ends, the model is unloaded from memory.

A job the AI has already scored below `MIN_MATCH_SCORE` (75 by default) is not applied to. A job it hasn't scored is.

### Set up Ollama

1. Install Ollama from https://ollama.com/download and start it. The bot never installs it for you.
2. Download a model. The bot never downloads models itself:
   ```bash
   ollama pull qwen3:4b
   ```

`qwen3:4b` (the default) is a 2.5 GB download and needs about 3.5 GB of free RAM while running. Use the native app rather than Docker: on a Mac, Ollama in Docker can't use the GPU and is much slower. Without Ollama, runs work the same; jobs just have no match score.

### How the score is worked out

The model reports evidence (required and preferred skills, how well the role fits the job's profiles, how central AI work is, other requirements, red flags); the score is calculated in code from it:

| Component | Weight |
| --- | --- |
| Role relevance | 30% |
| Required skills (80%) and preferred skills (20%) | 35% |
| AI/LLM focus (only for an `ai` profile) | 20% |
| Location | 10% |
| Other stated requirements | 5% |

- **Skill coverage** is decided in code: a job skill counts as yours only if it is one of your skills, a spelling variant ("React.js" and "React"), a built-in alias (see `src/jobs/skills.ts`), or an alias in your profile's `skillAliases`. A model claiming "LangGraph is covered by Python" changes nothing.
- **Only skills the posting names count.** A small model sometimes pads the lists with your own skills; those are dropped.
- **Experience** is never sent to the model and is never part of the score.
- **Privacy:** the model receives the job posting, the job's profile names, and your skills and preferred locations. Your name, contact details, resume and Naukri session are never sent.
- **OpenAI instead:** set `AI_PROVIDER=openai` and `OPENAI_API_KEY` in `.env`. This is paid and sends the same data to OpenAI. In Ollama mode no OpenAI request is ever made.

## What is verified

- **Checked against live Naukri pages:**
  - the Apply button (`#apply-button`) and the company-site button (`#company-site-button`)
  - the external URL in Naukri's job data
  - the freshness filter (`jobAge`), and that Naukri drops it for a keyword with a dot
  - a run with Auto apply off, including pause and resume
- **Seen once:** the "Applied" label that replaces Apply; it matched on one live job, recorded as `ALREADY_APPLIED`.
- **Not yet seen by the bot:** the recruiter-question chat, Naukri's post-apply confirmation, and separate application forms. Their selectors in `src/browser/selectors.ts` are marked as such. If they're wrong, the bot fails safe: jobs end as `NEEDS_REVIEW`, never as a false `APPLIED`.
- **Rolling out:** start with Auto apply off to see the queue, then one real application from the terminal (`npm run apply -- --max 1 --auto-apply`), check it in History and on Naukri, then a small run, then the whole queue. `DEBUG_SCREENSHOTS=true` saves each step to `data/debug/<run id>/`.

## Terminal commands

The dashboard is the normal way to use the bot. The same runs are available from the terminal for debugging; they can't run while `npm run server` holds the Chrome profile.

```bash
npm run login                     # log in to Naukri in Chrome
npm run session                   # check the saved session (exit code 0 when valid)
npm run apply                     # the same run as Start auto apply, with Auto apply off unless --auto-apply
npm run apply -- --profile react --location Bangalore --fresh 24h --experience 7 --tolerance 6
npm run apply -- --from 2026-09-20 --to 2026-09-26   # a custom date range
npm run apply -- --max 1 --auto-apply                # really apply to one job
npm run apply -- --skip-search                       # apply to jobs already stored
npm run search -- --profile react --fresh 3d         # search only, and read the descriptions
npm run analyze                   # AI-score every described job (--force to redo them)
npm run status                    # what's stored
npm run report                    # the latest run's report (or: npm run report -- RUN-20260925-233612)
```

Ctrl+C stops a run the way Stop does; a second Ctrl+C quits at once.

## Configuration

`.env` holds runtime settings; every value has a default (see `.env.example`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `AI_PROVIDER`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | `ollama`, `http://localhost:11434`, `qwen3:4b` | Local AI. |
| `AI_CONCURRENCY` | `1` | Analyses at a time. Keep 1 for a local model. |
| `MIN_MATCH_SCORE` | `75` | Jobs the AI scores below this are not applied to. |
| `AUTO_APPLY` | `false` | The Auto apply switch's starting position; the dashboard remembers your choice. |
| `SEARCH_MAX_PAGES` | `10` | Result pages read per keyword and location. |
| `DELAY_MIN_MS`, `DELAY_MAX_MS` | `1500`, `4000` | Pause between page loads. |
| `APPLY_DELAY_MS` | `10000` | Pause after each Apply click. |
| `HEADLESS` | `false` | Naukri refuses headless Chrome; keep it off. |
| `DEBUG_SCREENSHOTS` | `false` | Screenshots of each step and failure in `data/debug/`. They can show personal details. |
| `API_PORT` | `4100` | The local API's port. |

## Development

```bash
npm test                         # bot and dashboard tests; browser tests use fake local pages, never the real site
npm run typecheck
npm --prefix web run typecheck
npm --prefix web run build
npm run scan-secrets             # checks every file git would commit for secrets and personal files
```

`npm install` turns on a pre-commit hook that refuses commits containing private files (`.env`, `data/`, personal config, resumes, databases, logs, traces) or credentials. It warns about email addresses and phone numbers; check every warning before you commit.

## Troubleshooting

- **"Naukri refused this browser (Access Denied)".** Keep `HEADLESS=false`. With a visible window, you've probably made too many requests; wait and try later.
- **"Browser profile … is already in use".** Another bot run, its Chrome window, or `npm run server` is open. Close it.
- **"Port 4100 is in use".** Another `npm run server` is running. Stop it, or set `API_PORT`.
- **The dashboard says the bot server is not running.** Start `npm run server`; the dashboard reconnects on its own.
- **Google sign-in fails in the bot's window.** Google refuses sign-in from automated browsers. Use Naukri's email/password or OTP login.
- **A relevant job is missing.** Its title matched none of the chosen job profiles. Add a keyword or skill to a profile in `config/job-profiles.json`.
- **Few jobs are eligible.** Check the experience and tolerance on the Apply page; the Jobs page shows each job's reason.
- **"Ollama is not running" in the log.** Runs carry on without AI scores. Start the Ollama app to get them.
- **The Mac runs short of memory.** Close the dashboard's browser tabs you don't need, run Ollama natively rather than in Docker, and keep `AI_CONCURRENCY=1`. The bot uses one Chrome window with one tab and unloads the AI model after each run.
- **Starting over.** Delete `data/jobs.db*` to forget stored jobs; your login in `data/browser-profile/` is unaffected.

## Security and limitations

- The bot never solves or bypasses CAPTCHA, OTP, MFA or anti-bot checks, and does not hide that the browser is automated.
- It never answers a question from anything but your profile and saved answers, never continues on a company's own site, and never reports an application as applied without Naukri's confirmation.
- `data/browser-profile/` holds your Naukri session cookies. Don't share it; deleting it logs the bot out.
- If personal data or a credential is ever committed, deleting it later doesn't remove it from git history.
