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
  | 'SEARCH_FINISHED'
  | 'QUEUE_READY'
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

export const FRESHNESS = ['today', '24h', '2d', '3d', '7d', 'custom', 'all'] as const;
export type Freshness = (typeof FRESHNESS)[number];

const HOUR_MS = 3_600_000;

// "2026-09-20" as that day's local midnight, plus `days`.
function localDay(day: string, days = 0): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d! + days);
}

// Which jobs a search, a list or an application run covers.
export interface JobScope {
  // Job profile ids; none means all of them.
  profiles: string[];
  freshness: Freshness;
  // A custom range, as local dates (YYYY-MM-DD), both days included.
  from?: string | null;
  to?: string | null;
  // Cities to search and list; none means anywhere. Remote jobs always count.
  locations?: string[];
  // Jobs asking for more than experienceYears plus the tolerance are not eligible. null: not checked.
  experienceYears?: number | null;
  toleranceMonths?: number;
}

// The posting times a scope covers, [since, until); null leaves that end open. "Today" starts at
// local midnight.
export function freshWindow(scope: Pick<JobScope, 'freshness' | 'from' | 'to'>, now = new Date()): { since: string | null; until: string | null } {
  switch (scope.freshness) {
    case 'all':
      return { since: null, until: null };
    case 'today':
      return { since: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), until: null };
    case 'custom':
      return {
        since: scope.from ? localDay(scope.from).toISOString() : null,
        until: scope.to ? localDay(scope.to, 1).toISOString() : null,
      };
    default: {
      const hours = { '24h': 24, '2d': 48, '3d': 72, '7d': 168 }[scope.freshness];
      return { since: new Date(now.getTime() - hours * HOUR_MS).toISOString(), until: null };
    }
  }
}

// The most experience a job may ask for and still be applied to, or null when it isn't checked.
export function maxExperience(scope: Pick<JobScope, 'experienceYears' | 'toleranceMonths'>): number | null {
  return scope.experienceYears == null ? null : scope.experienceYears + (scope.toleranceMonths ?? 0) / 12;
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

// After each page of search results, so lists refresh while the search goes on. Not stored.
export interface SearchProgressEvent {
  type: 'SEARCH_PROGRESS';
  runId: string;
  found: number;
  added: number;
  timestamp: string;
}

export interface StateEvent {
  type: 'STATE';
  state: BotState;
  timestamp: string;
}

export type BotEvent = RunEvent | LogEvent | AnalysisProgressEvent | SearchProgressEvent | StateEvent;

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
  profileReady: boolean;
  lastRun: Run | null;
}

// A job's status as the dashboard shows it: where its latest attempt ended, or, for a job not
// attempted yet, whether it can be applied to.
export type JobCategory = Outcome | 'not_eligible';

export const CATEGORY_LABELS: Record<JobCategory, string> = { ...OUTCOME_LABELS, not_eligible: 'Not eligible' };

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
  // Why a job is not eligible: "Requires 10+ years", or a low AI match.
  ineligibleReason: string | null;
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
  // Jobs the AI has scored below this are not applied to; jobs it hasn't scored are.
  minMatchScore: number;
  // Click Apply and answer known questions. On Naukri that click, or the last answer, sends the application.
  autoApply: boolean;
  autoFill: boolean;
  delaySeconds: number;
  debugScreenshots: boolean;
  // Search Naukri before applying (the dashboard always does).
  search: boolean;
  // Only from the command line, for trying one or two jobs; the dashboard runs through the whole queue.
  limit: number | null;
}

// Where the jobs in a scope stand: the counts on the Dashboard and Apply pages.
export interface ScopeSummary {
  // Relevant to the chosen profiles, in the chosen locations, posted in the window.
  found: number;
  // Of those, the ones experience and the AI match allow applying to.
  eligible: number;
  counts: Record<JobCategory, number>;
  // What a run would work through now.
  queued: number;
  minMatchScore: number;
  problems: string[];
}

// The run settings the dashboard offers as defaults.
export interface RunDefaults {
  autoApply: boolean;
  locations: string[];
  experienceYears: number | null;
  toleranceMonths: number;
}

// The person applying. Stored only in data/user-profile.json on this machine.
export interface UserProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  // Current city.
  location: string;
  preferredLocations: string[];
  experienceYears: number;
  experienceToleranceMonths: number;
  currentRole: string;
  currentCompany: string;
  noticePeriodDays: number | null;
  currentSalary: string;
  expectedSalary: string;
  skills: string[];
  otherSkills: string[];
  // Extra names that count as one of your skills, e.g. { "Node.js": ["Express"] }.
  skillAliases: Record<string, string[]>;
  // A file in data/resume/.
  resumeFile: string | null;
}

// A recruiter question answered when it contains every phrase in `match`.
export interface SavedAnswer {
  match: string[];
  answer: string;
}

export interface ProfileResponse {
  profile: UserProfile | null;
  answers: SavedAnswer[];
  resume: { name: string; size: number } | null;
  // Where the profile was read from: the data folder, or older config/*.json files.
  source: 'data' | 'legacy' | null;
  ready: boolean;
  problems: string[];
  defaults: RunDefaults;
}
