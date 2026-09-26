// Statuses, events and API shapes shared by the bot, its local HTTP API and the dashboard.
// No imports, so the dashboard can bundle this file as is.

export const JOB_STATUSES = [
  'DISCOVERED',
  'ANALYZED',
  'SHORTLISTED',
  'REVIEW',
  'SKIPPED',
  'ANALYSIS_FAILED',
  'APPLICATION_STARTED',
  'READY_TO_SUBMIT',
  'APPLIED',
  'FAILED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type MatchBand = 'HIGH_MATCH' | 'MATCH' | 'REVIEW' | 'SKIP';

export type SessionState = 'LOGGED_IN' | 'LOGGED_OUT' | 'CHALLENGE' | 'BLOCKED';

// One row per job attempted in an application run. The first five are steps the bot is still in;
// the rest are where an attempt ended.
export const APPLICATION_STATUSES = [
  'APPLYING',
  'APPLY_CLICKED',
  'FORM_OPENED',
  'FORM_FILLED',
  'SUBMIT_CLICKED',
  // Internal Apply button found, Apply not clicked.
  'READY_TO_APPLY',
  // A form is open and filled, and only the final submit was held back.
  'READY_TO_SUBMIT',
  // Naukri confirmed it; nothing else counts.
  'APPLIED',
  'FAILED',
  'EXTERNAL',
  'NEEDS_REVIEW',
  'ALREADY_APPLIED',
  'SECURITY_CHALLENGE',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

// The simple status the dashboard shows, and how jobs are counted.
export type Outcome = 'ready' | 'applying' | 'applied' | 'failed' | 'external' | 'review' | 'already_applied';

export const OUTCOMES: Record<ApplicationStatus, Outcome> = {
  APPLYING: 'applying',
  APPLY_CLICKED: 'applying',
  FORM_OPENED: 'applying',
  FORM_FILLED: 'applying',
  SUBMIT_CLICKED: 'applying',
  READY_TO_APPLY: 'ready',
  READY_TO_SUBMIT: 'ready',
  APPLIED: 'applied',
  FAILED: 'failed',
  // The job may be fine; the run stopped on it and it is tried again next time.
  SECURITY_CHALLENGE: 'failed',
  EXTERNAL: 'external',
  NEEDS_REVIEW: 'review',
  ALREADY_APPLIED: 'already_applied',
};

export const OUTCOME_LABELS: Record<Outcome, string> = {
  ready: 'Ready to apply',
  applying: 'Applying',
  applied: 'Applied',
  failed: 'Failed',
  external: 'External',
  review: 'Review',
  already_applied: 'Already applied',
};

export type FailureCode =
  | 'ALREADY_APPLIED'
  | 'EXTERNAL_APPLICATION'
  | 'JOB_UNAVAILABLE'
  | 'APPLY_BUTTON_NOT_FOUND'
  | 'AUTO_APPLY_OFF'
  | 'AUTO_FILL_OFF'
  | 'UNKNOWN_REQUIRED_QUESTION'
  | 'ANSWER_NOT_IN_OPTIONS'
  | 'UNSUPPORTED_FIELD'
  | 'RESUME_MISSING'
  | 'TOO_MANY_QUESTIONS'
  | 'FORM_TIMEOUT'
  | 'SUBMIT_UNVERIFIED'
  | 'SUBMIT_ERROR'
  | 'PAGE_ERROR'
  | 'RUN_STOPPED'
  | 'INTERRUPTED'
  | StopCode;

// Why a whole run ended early.
export type StopCode = 'SECURITY_CHALLENGE' | 'ACCESS_DENIED' | 'SESSION_EXPIRED' | 'BROWSER_CLOSED' | 'UNVERIFIED_STREAK';

export const RUN_KINDS = ['SEARCH', 'ANALYZE', 'APPLY'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export type RunStatus = 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED' | 'FAILED';

export type RunEventType =
  | 'RUN_STARTED'
  | 'RUN_PAUSED'
  | 'RUN_RESUMED'
  | 'RUN_STOPPED'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'
  | 'JOB_STARTED'
  | 'JOB_OPENED'
  | 'APPLY_BUTTON_FOUND'
  | 'APPLY_CLICKED'
  | 'FORM_OPENED'
  | 'FORM_FIELD_DETECTED'
  | 'FORM_FIELD_FILLED'
  | 'RESUME_UPLOADED'
  | 'FORM_FILLED'
  | 'FORM_SUBMITTED'
  | 'APPLICATION_CONFIRMED'
  | 'READY_TO_APPLY'
  | 'READY_TO_SUBMIT'
  | 'ALREADY_APPLIED'
  | 'EXTERNAL_APPLICATION'
  | 'NEEDS_REVIEW'
  | 'SECURITY_CHALLENGE'
  | 'APPLICATION_FAILED';

// The event recorded when an attempt ends in each status.
export const FINAL_EVENTS: Record<ApplicationStatus, RunEventType> = {
  APPLYING: 'APPLICATION_FAILED',
  APPLY_CLICKED: 'APPLICATION_FAILED',
  FORM_OPENED: 'APPLICATION_FAILED',
  FORM_FILLED: 'APPLICATION_FAILED',
  SUBMIT_CLICKED: 'APPLICATION_FAILED',
  READY_TO_APPLY: 'READY_TO_APPLY',
  READY_TO_SUBMIT: 'READY_TO_SUBMIT',
  APPLIED: 'APPLICATION_CONFIRMED',
  FAILED: 'APPLICATION_FAILED',
  EXTERNAL: 'EXTERNAL_APPLICATION',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  SECURITY_CHALLENGE: 'SECURITY_CHALLENGE',
};

// "careers.example.com" from an external application URL, or null when it isn't one.
export function domainOf(url: string | null): string | null {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

export const FRESHNESS = ['today', '24h', '3d', '7d', 'all'] as const;
export type Freshness = (typeof FRESHNESS)[number];

const HOUR_MS = 3_600_000;

// The oldest posting time that still counts as fresh, or null for no limit. "Today" starts at local midnight.
export function freshSince(freshness: Freshness, now = new Date()): string | null {
  if (freshness === 'all') return null;
  if (freshness === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const hours = { '24h': 24, '3d': 72, '7d': 168 }[freshness];
  return new Date(now.getTime() - hours * HOUR_MS).toISOString();
}

// Which jobs a search, a list or an application run covers. No profiles means all of them.
export interface JobScope {
  profiles: string[];
  freshness: Freshness;
}

export interface JobProfileSummary {
  id: string;
  name: string;
}

export type EventDetail = Record<string, string | number | boolean | null | string[]>;

export interface RunEvent {
  type: RunEventType;
  runId: string;
  applicationId?: number;
  jobId?: number;
  company?: string;
  jobTitle?: string;
  status?: ApplicationStatus | RunStatus;
  message: string;
  reason?: string;
  detail?: EventDetail;
  timestamp: string;
}

export interface LogEvent {
  type: 'LOG';
  level: 'info' | 'warn' | 'error';
  message: string;
  runId?: string;
  timestamp: string;
}

export interface AnalysisProgressEvent {
  type: 'ANALYSIS_PROGRESS';
  runId: string;
  done: number;
  total: number;
  jobTitle: string;
  company: string;
  score: number | null;
  band: MatchBand | null;
  error: string | null;
  timestamp: string;
}

export interface StateEvent {
  type: 'STATE';
  state: BotState;
  timestamp: string;
}

export type BotEvent = RunEvent | LogEvent | AnalysisProgressEvent | StateEvent;

export type SessionStatus = SessionState | 'UNKNOWN' | 'WAITING_FOR_LOGIN';
export type BrowserStatus = 'RUNNING' | 'STOPPED';
export type Activity = 'BROWSER_START' | 'SESSION_CHECK' | 'LOGIN' | RunKind;

export interface BotState {
  session: SessionStatus;
  sessionCheckedAt: string | null;
  browser: BrowserStatus;
  activity: Activity | null;
  activeRun: { id: string; kind: RunKind; startedAt: string; paused: boolean; stopRequested: boolean } | null;
}

// Jobs by their simple status. Within one run every attempt counts; overall, each job counts once.
export type OutcomeCounts = Record<Outcome, number>;

export interface Run {
  id: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  stopReason: string | null;
  stopCode: StopCode | null;
  settings: Record<string, string | number | boolean | string[] | null>;
  // Counts the run's service reported (jobs seen, analyses done, queue size, ...).
  stats: Record<string, number>;
  // Where each attempt in this run ended (zeros for search and analysis runs).
  outcomes: OutcomeCounts;
  attempted: number;
}

export interface StatusResponse {
  state: BotState;
  ai: { provider: string; model: string };
  counts: { jobsFound: number; freshJobs: number; applied: number; failed: number };
  lastRun: Run | null;
}

// Jobs the matcher hasn't cleared for applying yet, next to the application outcomes.
export type JobCategory = Outcome | 'new' | 'low_match' | 'filtered';

export interface JobListItem {
  id: number;
  company: string;
  title: string;
  location: string | null;
  experience: string | null;
  postedAt: string | null;
  score: number | null;
  band: MatchBand | null;
  profiles: string[];
  jobStatus: JobStatus;
  applicationStatus: ApplicationStatus | null;
  category: JobCategory;
}

export interface JobPage {
  jobs: JobListItem[];
  total: number;
}

export interface JobAnalysis {
  provider: string;
  model: string;
  analyzedAt: string;
  score: number;
  band: MatchBand;
  reason: string;
  requiredSkills: string[];
  preferredSkills: string[];
  matchedSkills: string[];
  missingSkills: string[];
  missingPreferredSkills: string[];
  redFlags: string[];
  holdReason: string | null;
}

export interface JobDetail extends JobListItem {
  url: string;
  salary: string | null;
  workMode: string | null;
  skills: string[];
  description: string | null;
  discoveredAt: string;
  externalApply: boolean | null;
  externalUrl: string | null;
  filterReason: string | null;
  analysisError: string | null;
  analysis: JobAnalysis | null;
  applications: ApplicationRow[];
}

export interface ApplicationRow {
  id: number;
  runId: string;
  jobId: number;
  company: string;
  jobTitle: string;
  matchScore: number | null;
  status: ApplicationStatus;
  outcome: Outcome;
  applyButtonFound: boolean;
  applyClicked: boolean;
  formOpened: boolean;
  formFilled: boolean;
  submitClicked: boolean;
  successConfirmed: boolean;
  failureCode: FailureCode | null;
  failureReason: string | null;
  question: string | null;
  externalUrl: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface RunEventRecord {
  id: number;
  applicationId: number | null;
  type: RunEventType;
  message: string;
  reason: string | null;
  detail: EventDetail | null;
  createdAt: string;
}

export interface ApplicationDetail extends ApplicationRow {
  url: string;
  events: RunEventRecord[];
}

export interface RunDetail extends Run {
  applications: ApplicationRow[];
  // Run-level events only; each attempt's steps come with the attempt.
  events: RunEventRecord[];
}

export interface ApplySettings extends JobScope {
  minMatchScore: number;
  // Click Apply and answer known questions. On Naukri that click, or the last answer, sends the application.
  autoApply: boolean;
  autoFill: boolean;
  delaySeconds: number;
  debugScreenshots: boolean;
  // Only from the command line, for trying one or two jobs; the dashboard runs through the whole queue.
  limit: number | null;
}

// The Apply page: where the jobs in scope stand, and how many a run would work through now.
export interface ApplicationSummary {
  counts: OutcomeCounts;
  queued: number;
  // Shortlisting needs an AI match first; these still wait for one.
  awaitingMatch: number;
  minMatchScore: number;
  autoApply: boolean;
  problems: string[];
}
