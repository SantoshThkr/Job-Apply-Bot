import type { ApplicationDetail, ApplicationRow, ApplicationSummary, BotEvent, BotState, JobPage, RunEvent, StatusResponse } from '@bot/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApplyPage from '@/app/apply/page';
import JobsPage from '@/app/jobs/page';
import DashboardPage from '@/app/page';
import { ApplicationDetails, ApplicationTable } from '@/components/applications';
import { CurrentRun } from '@/components/live';
import { LiveProvider, reduce } from '@/lib/live';
import { ScopeProvider } from '@/lib/scope';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/', useParams: () => ({}) }));

// Stands in for the browser's EventSource; tests push server events through `emit`.
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close() {}
}

function emit(...events: BotEvent[]) {
  act(() => {
    for (const event of events) FakeEventSource.last!.onmessage!({ data: JSON.stringify(event) });
  });
}

const at = '2026-09-25T13:45:21.000Z';
const idle: BotState = { session: 'LOGGED_IN', sessionCheckedAt: at, browser: 'RUNNING', activity: null, activeRun: null };
const applying: BotState = {
  ...idle,
  activity: 'APPLY',
  activeRun: { id: 'RUN-20260925-134500', kind: 'APPLY', startedAt: at, paused: false, stopRequested: false },
};
const runEvent = (type: RunEvent['type'], message: string, extra: Partial<RunEvent> = {}): RunEvent => ({
  type,
  runId: 'RUN-20260925-134500',
  applicationId: 7,
  jobId: 3,
  company: 'Microsoft',
  jobTitle: 'Senior React Developer',
  message,
  timestamp: at,
  ...extra,
});

const status: StatusResponse = {
  state: idle,
  ai: { provider: 'Ollama', model: 'qwen3:4b' },
  counts: { jobsFound: 120, freshJobs: 37, applied: 94, failed: 8 },
  lastRun: null,
};
const summary: ApplicationSummary = {
  counts: { ready: 24, applying: 0, applied: 12, failed: 2, external: 5, review: 3, already_applied: 1 },
  queued: 26,
  awaitingMatch: 4,
  minMatchScore: 75,
  autoApply: false,
  problems: [],
};

const application = (overrides: Partial<ApplicationRow>): ApplicationRow => ({
  id: 1,
  runId: 'RUN-20260925-134500',
  jobId: 1,
  company: 'Microsoft',
  jobTitle: 'Senior React Developer',
  matchScore: 92,
  status: 'APPLIED',
  outcome: 'applied',
  applyButtonFound: true,
  applyClicked: true,
  formOpened: false,
  formFilled: false,
  submitClicked: true,
  successConfirmed: true,
  failureCode: null,
  failureReason: null,
  question: null,
  externalUrl: null,
  startedAt: at,
  completedAt: at,
  ...overrides,
});

let responses: Record<string, unknown>;
const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
  const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`;
  if (!(key in responses)) return new Response(JSON.stringify({ error: `no mock for ${key}` }), { status: 404 });
  return new Response(JSON.stringify(responses[key]), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
const calls = (key: string) => fetchMock.mock.calls.filter(([path, init]) => `${init?.method ?? 'GET'} ${String(path).split('?')[0]}` === key);

beforeEach(() => {
  responses = {
    'GET /api/status': status,
    'GET /api/profiles': [
      { id: 'frontend', name: 'Frontend Developer' },
      { id: 'react', name: 'React.js Developer' },
    ],
    'GET /api/applications/summary': summary,
    'GET /api/runs': [],
    'GET /api/jobs': { jobs: [], total: 0 },
  };
  fetchMock.mockClear();
  push.mockClear();
  localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const withProviders = (ui: ReactNode) =>
  render(
    <LiveProvider>
      <ScopeProvider>{ui}</ScopeProvider>
    </LiveProvider>,
  );

describe('dashboard', () => {
  it('shows the status, the four counts, and that nothing is running', async () => {
    withProviders(<DashboardPage />);
    emit({ type: 'STATE', state: idle, timestamp: at });
    expect(await screen.findByText('Ollama / qwen3:4b')).toBeTruthy();
    expect(screen.getByText('Logged in')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    const counts = Object.fromEntries(screen.getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent]));
    expect(counts).toMatchObject({ 'Jobs found': '120', 'Fresh jobs (24h)': '37', Applied: '94', Failed: '8' });
    expect(screen.getByText('No active application run.')).toBeTruthy();
  });

  it('follows the current job step by step', () => {
    withProviders(<CurrentRun />);
    emit(
      { type: 'STATE', state: applying, timestamp: at },
      runEvent('RUN_STARTED', 'Application run started', { applicationId: undefined }),
      runEvent('JOB_STARTED', 'Started 37/120', { detail: { position: 37, total: 120, score: 91 } }),
      runEvent('JOB_OPENED', 'Job opened'),
      runEvent('APPLY_BUTTON_FOUND', 'Apply button found'),
      runEvent('APPLY_CLICKED', 'Apply clicked'),
    );
    expect(screen.getByText('37 / 120')).toBeTruthy();
    expect(screen.getByText('Microsoft')).toBeTruthy();
    expect(screen.getByText('Senior React Developer')).toBeTruthy();
    expect(screen.getByText('Apply clicked')).toBeTruthy();
    expect(screen.getByText('Working…')).toBeTruthy();

    emit(runEvent('APPLICATION_CONFIRMED', 'Application confirmed: Naukri showed "You have successfully applied"', { status: 'APPLIED' }));
    expect(screen.getByText(/Application confirmed/)).toBeTruthy();
    expect(screen.getByText('Status').parentElement?.textContent).toContain('Applied');

    // The next job replaces the previous one's steps.
    emit(runEvent('JOB_STARTED', 'Started 38/120', { applicationId: 8, company: 'Deloitte', detail: { position: 38, total: 120, score: 88 } }));
    expect(screen.getByText('38 / 120')).toBeTruthy();
    expect(screen.queryByText(/Application confirmed/)).toBeNull();
  });

  it('never shows Applied without Naukri’s confirmation', () => {
    withProviders(<CurrentRun />);
    emit(
      { type: 'STATE', state: applying, timestamp: at },
      runEvent('JOB_STARTED', 'Started 1/1', { detail: { position: 1, total: 1, score: 88 } }),
      runEvent('APPLY_CLICKED', 'Apply clicked'),
      runEvent('FORM_SUBMITTED', 'No questions and no confirmation appeared; the Apply click may have sent the application'),
      runEvent('NEEDS_REVIEW', 'Needs review: Sent, but Naukri showed no confirmation', { status: 'NEEDS_REVIEW', reason: 'SUBMIT_UNVERIFIED' }),
    );
    expect(screen.getByText('Status').parentElement?.textContent).toContain('Review');
    expect(screen.queryByText('Applied')).toBeNull();
  });
});

describe('apply page', () => {
  it('shows where the chosen jobs stand and starts a run over the whole queue', async () => {
    responses['POST /api/applications/start'] = { runId: 'RUN-20260925-134500' };
    withProviders(<ApplyPage />);
    emit({ type: 'STATE', state: idle, timestamp: at });

    expect(await screen.findByText('Start (26)')).toBeTruthy();
    const counts = Object.fromEntries(screen.getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent]));
    expect(counts).toMatchObject({ 'Ready to apply': '24', Applying: '0', Applied: '12', Failed: '2', External: '5', Review: '3' });
    expect(screen.queryByLabelText(/maximum/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'React.js Developer' }));
    fireEvent.click(screen.getByRole('button', { name: '24 hours' }));
    await waitFor(() => expect(calls('GET /api/applications/summary').at(-1)?.[0]).toContain('profiles=react&freshness=24h'));

    fireEvent.click(screen.getByText('Start (26)'));
    await waitFor(() => expect(calls('POST /api/applications/start')).toHaveLength(1));
    expect(JSON.parse(calls('POST /api/applications/start')[0]![1]!.body as string)).toEqual({ profiles: ['react'], freshness: '24h', autoApply: false });
  });

  it('asks before turning auto apply on', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    withProviders(<ApplyPage />);
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
    fireEvent.click(toggle);
    expect(confirm).toHaveBeenCalled();
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  it('pauses, resumes and stops the active run', async () => {
    responses['POST /api/runs/pause'] = applying;
    responses['POST /api/runs/resume'] = applying;
    responses['POST /api/runs/stop'] = applying;
    withProviders(<ApplyPage />);
    emit({ type: 'STATE', state: applying, timestamp: at });

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(calls('POST /api/runs/pause')).toHaveLength(1));
    emit({ type: 'STATE', state: { ...applying, activeRun: { ...applying.activeRun!, paused: true } }, timestamp: at });
    expect(screen.getByText('Paused. Nothing is clicked until you resume.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(calls('POST /api/runs/resume')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(calls('POST /api/runs/stop')).toHaveLength(1));
    emit({ type: 'STATE', state: { ...applying, activeRun: { ...applying.activeRun!, stopRequested: true } }, timestamp: at });
    expect((screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('jobs page', () => {
  const page: JobPage = {
    total: 1,
    jobs: [
      {
        id: 3,
        company: 'Microsoft',
        title: 'Senior React Developer',
        location: 'Bangalore',
        experience: '10-15 Yrs',
        postedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        score: 92,
        band: 'HIGH_MATCH',
        profiles: ['react'],
        jobStatus: 'SHORTLISTED',
        applicationStatus: null,
        category: 'ready',
      },
    ],
  };

  it('lists jobs for the chosen profiles and freshness, and searches with the same choice', async () => {
    responses['GET /api/jobs'] = page;
    responses['POST /api/jobs/search'] = { runId: 'RUN-20260925-134500' };
    withProviders(<JobsPage />);
    emit({ type: 'STATE', state: idle, timestamp: at });

    const row = (await screen.findByText('Senior React Developer')).closest('tr')!;
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Microsoft', 'Senior React Developer', 'Bangalore', '3h ago', '92', '○Ready to apply']);
    expect(screen.queryByLabelText(/experience/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Frontend Developer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(calls('GET /api/jobs').at(-1)?.[0]).toContain('profiles=frontend&freshness=today'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'failed' } });
    await waitFor(() => expect(calls('GET /api/jobs').at(-1)?.[0]).toContain('status=failed'));

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls('POST /api/jobs/search')).toHaveLength(1));
    expect(JSON.parse(calls('POST /api/jobs/search')[0]![1]!.body as string)).toEqual({ profiles: ['frontend'], freshness: 'today' });

    fireEvent.click(screen.getByText('Bangalore'));
    expect(push).toHaveBeenCalledWith('/jobs/3');
  });
});

describe('results', () => {
  it('shows each job’s simple status and the exact reason', () => {
    const onSelect = vi.fn();
    render(
      <ApplicationTable
        onSelect={onSelect}
        applications={[
          application({}),
          application({ id: 2, company: 'Accenture', jobTitle: 'React Developer', status: 'FAILED', outcome: 'failed', submitClicked: false, successConfirmed: false, failureCode: 'FORM_TIMEOUT', failureReason: 'The recruiter questions stopped responding' }),
          application({ id: 3, company: 'TCS', jobTitle: 'Frontend Engineer', status: 'EXTERNAL', outcome: 'external', applyClicked: false, submitClicked: false, successConfirmed: false, failureCode: 'EXTERNAL_APPLICATION', failureReason: "Applies on the company's site (careers.tcs.com)" }),
        ]}
      />,
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => row.querySelector('td')?.textContent)).toEqual(['Microsoft', 'Accenture', 'TCS']);
    expect(within(rows[0]!).getByText('Applied')).toBeTruthy();
    expect(within(rows[1]!).getByText('The recruiter questions stopped responding')).toBeTruthy();
    expect(within(rows[2]!).getByText('External')).toBeTruthy();

    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Accenture' }));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('opens a job’s steps, exact state and the question it stopped at', async () => {
    const detail: ApplicationDetail = {
      ...application({
        id: 5,
        company: 'Accenture',
        status: 'NEEDS_REVIEW',
        outcome: 'review',
        formOpened: true,
        submitClicked: false,
        successConfirmed: false,
        failureCode: 'UNKNOWN_REQUIRED_QUESTION',
        failureReason: 'No answer for this question in config/answers.json or your profile',
        question: 'Do you have authorization to work in the US?',
      }),
      url: 'https://www.naukri.com/job-listings-x-1',
      events: [
        { id: 1, applicationId: 5, type: 'JOB_OPENED', message: 'Job opened', reason: null, detail: null, createdAt: at },
        { id: 2, applicationId: 5, type: 'FORM_FIELD_DETECTED', message: 'Question: "Do you have authorization to work in the US?"', reason: null, detail: { options: ['Yes', 'No'] }, createdAt: at },
      ],
    };
    responses['GET /api/applications/5'] = detail;
    withProviders(<ApplicationDetails id={5} />);
    expect(await screen.findByText('“Do you have authorization to work in the US?”')).toBeTruthy();
    expect(screen.getByText('NEEDS_REVIEW')).toBeTruthy();
    expect(screen.getByText('(UNKNOWN_REQUIRED_QUESTION)')).toBeTruthy();
    expect(screen.getByText('Options: Yes | No')).toBeTruthy();
    expect(screen.getByText('Submitted: no')).toBeTruthy();
  });
});

describe('live stream reducer', () => {
  it('keeps only the current job’s steps, however long the run', () => {
    let live = reduce({ connected: true, state: null, log: [], run: [], analysis: null, version: 0 }, runEvent('RUN_STARTED', 'started', { applicationId: undefined }));
    for (let job = 1; job <= 1_000; job++) {
      live = reduce(live, runEvent('JOB_STARTED', `job ${job}`, { applicationId: job }));
      live = reduce(live, runEvent('APPLICATION_CONFIRMED', 'confirmed', { applicationId: job, status: 'APPLIED' }));
    }
    expect(live.run.map((e) => e.message)).toEqual(['started', 'job 1000', 'confirmed']);
    expect(live.version).toBe(1_001);
    live = reduce(live, runEvent('RUN_STARTED', 'next run', { runId: 'RUN-20260925-140000', applicationId: undefined }));
    expect(live.run.map((e) => e.message)).toEqual(['next run']);
  });
});
