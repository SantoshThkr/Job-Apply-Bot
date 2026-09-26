import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright';
import {
  answerQuestion,
  clickApply,
  errorEvidence,
  fillField,
  openJobPage,
  readForm,
  readQuestion,
  submitForm,
  successEvidence,
  type Question,
  type Reply,
} from '../browser/apply.ts';
import { saveStepScreenshot } from '../browser/browser.ts';
import { RunStopped } from '../browser/session.ts';
import type { Answer } from '../config.ts';
import { applicationQueue, previousApplication, startApplication, updateApplication, type ApplicationChanges, type QueueItem } from '../db/applications.ts';
import { markJobApplied } from '../db/jobs.ts';
import { FINAL_EVENTS, domainOf, type ApplicationStatus, type ApplySettings, type FailureCode, type RunEvent, type RunEventType } from '../domain.ts';
import { recordRunEvent } from '../events.ts';
import { log } from '../logger.ts';
import { answerFor, findAnswer, pickOption, type ApplicantFacts } from './answers.ts';

// Naukri asks a handful at most; more means the bot is misreading the drawer.
const MAX_QUESTIONS = 15;
// Several unconfirmed submissions in a row suggest Naukri's pages changed; stop and let the user look.
const MAX_UNVERIFIED_IN_A_ROW = 3;

export interface ApplyContext {
  page: Page;
  db: DatabaseSync;
  runId: string;
  settings: ApplySettings;
  answers: Answer[];
  facts: ApplicantFacts | null;
  resumePath: string | null;
  signal?: AbortSignal;
  // Resolves at once unless the run is paused; otherwise once it is resumed or stopped.
  whilePaused?: () => Promise<void>;
  // Upper bound for each wait on Naukri (page controls, reaction to Apply, next question).
  waitMs?: number;
  // The pause after a job where nothing was clicked (DELAY_MIN_MS..DELAY_MAX_MS); after an Apply
  // click the longer settings.delaySeconds applies.
  browseDelayMs?: [number, number];
}

export function isAnsweredBy(answers: Answer[], facts: ApplicantFacts | null = null): (question: string) => boolean {
  return (question) => answerFor(question, answers, facts) !== null;
}

// Works through every job in the queue, freshest first, until it is done, stopped, or Naukri makes
// continuing unsafe. `settings.limit` is only for trying one or two jobs from the command line.
export async function applyToJobs(ctx: ApplyContext, stats: Record<string, number>): Promise<void> {
  const { jobs: queued, excluded } = applicationQueue(ctx.db, {
    scope: ctx.settings,
    minMatchScore: ctx.settings.minMatchScore,
    isAnswered: isAnsweredBy(ctx.answers, ctx.facts),
  });
  const jobs = ctx.settings.limit ? queued.slice(0, ctx.settings.limit) : queued;
  stats.queued = jobs.length;
  stats.excluded = excluded.length;
  log.info(`${jobs.length} job(s) queued at match ${ctx.settings.minMatchScore}+${excluded.length ? `, ${excluded.length} left out` : ''}`);

  let unverified = 0;
  let clickedLast = false;
  for (const [index, job] of jobs.entries()) {
    await ctx.whilePaused?.();
    if (ctx.signal?.aborted) break;
    if (index > 0) {
      const [min, max] = ctx.browseDelayMs ?? [1_500, 4_000];
      const ms = clickedLast ? ctx.settings.delaySeconds * 1_000 : min + Math.random() * (max - min);
      if (!(await pause(ms, ctx.signal))) break;
    }
    const attempt = new Attempt(ctx, job, index + 1, jobs.length);
    const status = await attempt.run();
    clickedLast = attempt.clicked;
    stats.processed = index + 1;
    unverified = status === 'NEEDS_REVIEW' && attempt.possiblySent ? unverified + 1 : 0;
    if (unverified >= MAX_UNVERIFIED_IN_A_ROW) {
      throw new RunStopped(
        `${unverified} applications in a row were sent but Naukri never confirmed them. Check them on Naukri before running again.`,
        'UNVERIFIED_STREAK',
      );
    }
  }
}

// False when the run was stopped during the wait.
async function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  try {
    await sleep(ms, undefined, { signal });
    return true;
  } catch {
    return false;
  }
}

const firstLine = (text: string) => text.split('\n')[0]!.trim();

const FINAL_MESSAGES: Partial<Record<ApplicationStatus, string>> = {
  READY_TO_APPLY: 'Ready to apply',
  READY_TO_SUBMIT: 'Ready to submit',
  APPLIED: 'Application confirmed',
  FAILED: 'Failed',
  EXTERNAL: 'External application',
  NEEDS_REVIEW: 'Needs review',
  ALREADY_APPLIED: 'Already applied',
  SECURITY_CHALLENGE: 'Security check',
};

// One job's attempt: its applications row, its timeline, and the rules for how it may end.
class Attempt {
  #ctx: ApplyContext;
  #job: QueueItem;
  #position: number;
  #id: number;
  #state: Required<Pick<ApplicationChanges, 'status' | 'applyClicked' | 'formOpened' | 'submitClicked'>> = {
    status: 'APPLYING',
    applyClicked: false,
    formOpened: false,
    submitClicked: false,
  };

  constructor(ctx: ApplyContext, job: QueueItem, position: number, total: number) {
    this.#ctx = ctx;
    this.#job = job;
    this.#position = position;
    this.#id = startApplication(ctx.db, ctx.runId, job);
    this.#event('JOB_STARTED', `Started ${position}/${total}: ${job.title}`, { detail: { position, total, score: job.score } });
  }

  get clicked(): boolean {
    return this.#state.applyClicked;
  }

  // Apply was clicked without a form opening, or a submit was clicked: Naukri may have the application.
  get possiblySent(): boolean {
    const { applyClicked, formOpened, submitClicked } = this.#state;
    return applyClicked && (!formOpened || submitClicked);
  }

  get #waits(): { waitMs?: number } {
    return this.#ctx.waitMs === undefined ? {} : { waitMs: this.#ctx.waitMs };
  }

  async run(): Promise<ApplicationStatus> {
    try {
      return await this.#apply();
    } catch (err) {
      if (err instanceof RunStopped) {
        const blocked = err.code === 'SECURITY_CHALLENGE' || err.code === 'ACCESS_DENIED';
        this.#finish(this.#unconfirmed(blocked ? 'SECURITY_CHALLENGE' : 'FAILED'), { code: err.code, reason: err.message });
        throw err;
      }
      if (this.#ctx.page.isClosed()) {
        this.#finish(this.#unconfirmed('FAILED'), { code: 'BROWSER_CLOSED', reason: 'The browser window was closed' });
        throw new RunStopped('The browser window was closed during the run.', 'BROWSER_CLOSED');
      }
      await this.#screenshot('failure');
      return this.#finish(this.#unconfirmed('FAILED'), { code: 'PAGE_ERROR', reason: firstLine((err as Error).message) });
    }
  }

  // Waits out a pause at a point where nothing is half done. True when the run was stopped instead.
  async #stopped(): Promise<boolean> {
    await this.#ctx.whilePaused?.();
    return Boolean(this.#ctx.signal?.aborted);
  }

  async #apply(): Promise<ApplicationStatus> {
    const { db, page, settings } = this.#ctx;
    const job = this.#job;

    const earlier = previousApplication(db, job.jobId);
    if (earlier) {
      return this.#finish('ALREADY_APPLIED', { code: 'ALREADY_APPLIED', reason: `Applied on ${earlier.appliedAt.slice(0, 10)} (${earlier.runId})` });
    }

    const state = await openJobPage(page, job.url, this.#waits);
    this.#event('JOB_OPENED', 'Job opened');
    await this.#screenshot('before-apply');
    switch (state.kind) {
      case 'ALREADY_APPLIED':
        markJobApplied(db, job.jobId);
        return this.#finish('ALREADY_APPLIED', { code: 'ALREADY_APPLIED', reason: 'Naukri already shows this job as applied' });
      case 'EXTERNAL': {
        const domain = domainOf(state.externalUrl);
        return this.#finish('EXTERNAL', {
          code: 'EXTERNAL_APPLICATION',
          reason: `Applies on the company's site${domain ? ` (${domain})` : ''}; the bot does not continue there`,
          changes: { externalUrl: state.externalUrl },
        });
      }
      case 'UNAVAILABLE':
        return this.#finish('FAILED', { code: 'JOB_UNAVAILABLE', reason: state.reason });
      case 'NO_BUTTON':
        return this.#finish('FAILED', { code: 'APPLY_BUTTON_NOT_FOUND', reason: 'No Apply button on the job page' });
    }

    this.#update({ applyButtonFound: true });
    this.#event('APPLY_BUTTON_FOUND', 'Apply button found');
    if (!settings.autoApply) {
      return this.#finish('READY_TO_APPLY', { code: 'AUTO_APPLY_OFF', reason: 'Auto apply is off, so the bot did not click Apply' });
    }
    if (await this.#stopped()) {
      return this.#finish('READY_TO_APPLY', { code: 'RUN_STOPPED', reason: 'Run stopped before Apply was clicked; nothing was sent' });
    }

    const clicked = await clickApply(page, this.#waits);
    this.#update({ status: 'APPLY_CLICKED', applyClicked: true });
    this.#event('APPLY_CLICKED', 'Apply clicked');

    let evidence: string | null = null;
    switch (clicked.kind) {
      case 'EXTERNAL': {
        const domain = domainOf(clicked.url);
        return this.#finish('EXTERNAL', {
          code: 'EXTERNAL_APPLICATION',
          reason: `Apply opened ${domain ?? 'another site'}; the bot does not continue there`,
          changes: { externalUrl: clicked.url },
        });
      }
      case 'ERROR':
        await this.#screenshot('failure');
        return this.#finish('FAILED', { code: 'SUBMIT_ERROR', reason: clicked.evidence });
      case 'QUESTIONNAIRE': {
        await this.#formOpened('Recruiter questions opened');
        const answered = await this.#answerQuestions();
        if (answered !== 'ANSWERED') return answered;
        this.#update({ status: 'SUBMIT_CLICKED', formFilled: true, submitClicked: true });
        this.#event('FORM_SUBMITTED', 'All questions answered; Naukri sends the application with the last answer');
        evidence = await successEvidence(page);
        break;
      }
      case 'FORM': {
        await this.#formOpened('Application form opened');
        const filled = await this.#fillForm();
        if (filled !== 'SUBMITTED') return filled;
        evidence = await successEvidence(page);
        break;
      }
      default:
        // No questions: on Naukri the Apply click itself sends the application.
        this.#update({ status: 'SUBMIT_CLICKED', submitClicked: true });
        this.#event(
          'FORM_SUBMITTED',
          clicked.kind === 'CONFIRMED'
            ? 'No recruiter questions: the Apply click sent the application'
            : 'No questions and no confirmation appeared; the Apply click may have sent the application',
        );
        if (clicked.kind === 'CONFIRMED') evidence = clicked.evidence;
    }
    return this.#verify(evidence);
  }

  // APPLIED only on Naukri's own evidence: its confirmation, or the job page saying Applied after a
  // reload. An error message from Naukri means it failed; no evidence either way means someone checks.
  async #verify(evidence: string | null): Promise<ApplicationStatus> {
    const { db, page } = this.#ctx;
    const job = this.#job;
    const error = evidence ? null : await errorEvidence(page);
    if (error) {
      await this.#screenshot('failure');
      return this.#finish('FAILED', { code: 'SUBMIT_ERROR', reason: error });
    }
    if (!evidence && (await openJobPage(page, job.url, this.#waits)).kind === 'ALREADY_APPLIED') evidence = 'Naukri now shows the job as Applied';
    await this.#screenshot(evidence ? 'success' : 'unconfirmed');
    if (!evidence) {
      return this.#finish('NEEDS_REVIEW', {
        code: 'SUBMIT_UNVERIFIED',
        reason: 'Sent, but Naukri showed no confirmation and the job page does not say Applied; check it on Naukri',
      });
    }

    db.exec('BEGIN');
    try {
      markJobApplied(db, job.jobId);
      const status = this.#finish('APPLIED', { message: `Application confirmed: ${evidence}`, changes: { successConfirmed: true } });
      db.exec('COMMIT');
      return status;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  async #formOpened(message: string): Promise<void> {
    this.#update({ status: 'FORM_OPENED', formOpened: true });
    this.#event('FORM_OPENED', message);
    await this.#screenshot('application-form');
  }

  async #answerQuestions(): Promise<'ANSWERED' | ApplicationStatus> {
    const { page } = this.#ctx;
    let seen = 0;
    for (let asked = 0; asked < MAX_QUESTIONS; asked++) {
      const step = await readQuestion(page, seen, this.#waits);
      if (step === 'DONE') return 'ANSWERED';
      if (step === 'TIMEOUT') {
        return this.#finish('FAILED', { code: 'FORM_TIMEOUT', reason: 'The recruiter questions stopped responding; the application was not completed' });
      }
      const { question } = step;
      seen = step.messages;
      this.#event('FORM_FIELD_DETECTED', `Question: "${question.text}"`, {
        detail: { question: question.text, kind: question.kind, options: question.options },
      });

      const reply = this.#replyTo(question);
      if (typeof reply === 'string') return reply;
      // Any answer may be the last one, and the last one sends the application.
      if (await this.#stopped()) {
        return this.#finish('FAILED', { code: 'RUN_STOPPED', reason: 'Run stopped while answering recruiter questions; nothing was submitted' });
      }
      await answerQuestion(page, question, reply);
      if ('file' in reply) this.#event('RESUME_UPLOADED', 'Resume uploaded');
      else {
        const answer = 'text' in reply ? reply.text : reply.options.join(', ');
        this.#event('FORM_FIELD_FILLED', `Answered "${question.text}": ${answer}`, { detail: { question: question.text, answer } });
      }
    }
    return this.#finish('NEEDS_REVIEW', { code: 'TOO_MANY_QUESTIONS', reason: `More than ${MAX_QUESTIONS} questions; finish this one by hand` });
  }

  // What to enter for a recruiter question, or the status the attempt ended in because nothing safe can be entered.
  #replyTo(question: Question): Reply | ApplicationStatus {
    const { settings, answers, facts, resumePath } = this.#ctx;
    const review = (code: FailureCode, reason: string) => this.#finish('NEEDS_REVIEW', { code, reason, changes: { question: question.text } });

    if (!settings.autoFill) return review('AUTO_FILL_OFF', 'Auto fill is off and this job asks recruiter questions');
    if (question.kind === 'unsupported') return review('UNSUPPORTED_FIELD', 'The question uses a field the bot cannot fill');
    if (question.kind === 'file') {
      return resumePath && existsSync(resumePath) ? { file: resumePath } : review('RESUME_MISSING', 'A file upload was requested and no resume is configured');
    }
    const configured = findAnswer(question.text, answers);
    const notAnOption = () => review('ANSWER_NOT_IN_OPTIONS', `The configured answer "${configured}" is not one of: ${question.options.join(' | ')}`);
    if (question.kind === 'multi') {
      const picked = (configured ?? '').split(',').map((a) => pickOption(question.options, a.trim()));
      if (!configured) return review('UNKNOWN_REQUIRED_QUESTION', 'No answer for this question in config/answers.json');
      return picked.every(Boolean) ? { options: picked as string[] } : notAnOption();
    }
    const answer = answerFor(question.text, answers, facts, question.options);
    if (answer) return question.kind === 'text' ? { text: answer } : { options: [answer] };
    return configured ? notAnOption() : review('UNKNOWN_REQUIRED_QUESTION', 'No answer for this question in config/answers.json or your profile');
  }

  // A form with its own submit button: fill what is known, stop at anything required that isn't, and
  // submit only once every required field has a value.
  async #fillForm(): Promise<'SUBMITTED' | ApplicationStatus> {
    const { page, settings, answers, facts, resumePath } = this.#ctx;
    for (const field of await readForm(page)) {
      if (field.filled) continue;
      let value: string | null = null;
      if (field.kind === 'file') value = resumePath && existsSync(resumePath) ? resumePath : null;
      else if (field.kind !== 'unsupported' && settings.autoFill) value = answerFor(field.label, answers, facts, field.options);
      if (value === null) {
        if (!field.required) continue;
        const code: FailureCode = field.kind === 'unsupported' ? 'UNSUPPORTED_FIELD' : settings.autoFill ? 'UNKNOWN_REQUIRED_QUESTION' : 'AUTO_FILL_OFF';
        return this.#finish('NEEDS_REVIEW', {
          code,
          reason: `Required field "${field.label}" has no safe answer; nothing was submitted`,
          changes: { question: field.label },
        });
      }
      await fillField(page, field, value);
      if (field.kind === 'file') this.#event('RESUME_UPLOADED', 'Resume uploaded');
      else this.#event('FORM_FIELD_FILLED', `Filled "${field.label}"`, { detail: { question: field.label } });
    }
    this.#update({ status: 'FORM_FILLED', formFilled: true });
    this.#event('FORM_FILLED', 'Every required field is filled');
    this.#event('READY_TO_SUBMIT', 'Ready to submit');
    if (await this.#stopped()) {
      return this.#finish('READY_TO_SUBMIT', { code: 'RUN_STOPPED', reason: 'Run stopped with the form filled; it was not submitted' });
    }
    if (!(await submitForm(page))) {
      return this.#finish('NEEDS_REVIEW', { code: 'UNSUPPORTED_FIELD', reason: 'The form has no submit button the bot recognises; nothing was submitted' });
    }
    this.#update({ status: 'SUBMIT_CLICKED', submitClicked: true });
    this.#event('FORM_SUBMITTED', 'Form submitted');
    return 'SUBMITTED';
  }

  // Once Apply was clicked without a form, or a submit was clicked, only Naukri knows whether the
  // application went through, so the attempt can't be called failed.
  #unconfirmed(fallback: ApplicationStatus): ApplicationStatus {
    return this.possiblySent ? 'NEEDS_REVIEW' : fallback;
  }

  #update(changes: ApplicationChanges): void {
    const row = updateApplication(this.#ctx.db, this.#id, changes);
    this.#state = { status: row.status, applyClicked: row.applyClicked, formOpened: row.formOpened, submitClicked: row.submitClicked };
  }

  #finish(
    status: ApplicationStatus,
    { code = null, reason = null, message, changes = {} }: { code?: FailureCode | null; reason?: string | null; message?: string; changes?: ApplicationChanges },
  ): ApplicationStatus {
    this.#update({ ...changes, status, failureCode: code, failureReason: reason });
    const label = FINAL_MESSAGES[status] ?? status;
    this.#event(FINAL_EVENTS[status], message ?? (reason ? `${label}: ${reason}` : label), { status, reason: code ?? undefined });
    return status;
  }

  #event(type: RunEventType, message: string, extra: Pick<RunEvent, 'status' | 'reason' | 'detail'> = {}): void {
    const { db, runId } = this.#ctx;
    const { jobId, company, title } = this.#job;
    recordRunEvent(db, { type, runId, applicationId: this.#id, jobId, company, jobTitle: title, message, ...extra });
  }

  async #screenshot(step: string): Promise<void> {
    if (!this.#ctx.settings.debugScreenshots) return;
    await saveStepScreenshot(this.#ctx.page, this.#ctx.runId, `${this.#position}-${this.#job.company}-${step}`);
  }
}
