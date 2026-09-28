import type { ApplicationDetail, ApplicationRow, BotEvent, BotState, JobPage, ProfileResponse, RunEvent, ScopeSummary, StatusResponse, UserProfile } from '@bot/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApplyPage from '@/app/apply/page';
import JobsPage from '@/app/jobs/page';
import DashboardPage from '@/app/page';
import ProfilePage from '@/app/profile/page';
import { ApplicationDetails, ApplicationTable } from '@/components/applications';
import { CurrentRun } from '@/components/live';
import { LiveProvider, reduce } from '@/lib/live';
import { SettingsProvider } from '@/lib/scope';

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
  activeRun: { id: 'RUN-20260925-134500', kind: 'APPLY', startedAt: at, autoApply: true, paused: false, stopRequested: false },
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

const status: StatusResponse = { state: idle, ai: { provider: 'Ollama', model: 'qwen3:4b' }, profileReady: true, lastRun: null };
const summary: ScopeSummary = {
  found: 120,
  eligible: 42,
  counts: { ready: 16, applying: 0, applied: 18, failed: 1, external: 5, review: 2, already_applied: 0, not_eligible: 78 },
  queued: 17,
  minMatchScore: 75,
  problems: [],
};
// Not anyone's real details.
const user: UserProfile = {
  firstName: 'Test',
  lastName: 'Candidate',
  email: 'candidate@example.com',
  phone: '0000000000',
  location: 'Bangalore',
  preferredLocations: ['Bangalore'],
  experienceYears: 7,
  experienceToleranceMonths: 6,
  currentRole: 'Engineer',
  currentCompany: 'Example Co',
  noticePeriodDays: 30,
  currentSalary: '',
  expectedSalary: '',
  skills: ['React', 'TypeScript'],
  otherSkills: [],
  skillAliases: {},
  resumeFile: 'cv.pdf',
};
const profile: ProfileResponse = {
  profile: user,
  answers: [{ match: ['relocate'], answer: 'Yes' }],
  resume: { name: 'cv.pdf', size: 20_480 },
  source: 'data',
  ready: true,
  problems: [],
  defaults: { locations: ['Bangalore'], experienceYears: 7, toleranceMonths: 6 },
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
    'GET /api/profile': profile,
    'GET /api/profiles': [
      { id: 'frontend', name: 'Frontend Developer' },
      { id: 'react', name: 'React.js Developer' },
    ],
    'GET /api/summary': summary,
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
      <SettingsProvider>{ui}</SettingsProvider>
    </LiveProvider>,
  );

const countsOnPage = () => Object.fromEntries(screen.getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent]));

describe('dashboard', () => {
  it('shows the status, the counts for the chosen jobs, and that nothing is running', async () => {
    withProviders(<DashboardPage />);
    emit({ type: 'STATE', state: idle, timestamp: at });
    expect(await screen.findByText('Ollama / qwen3:4b')).toBeTruthy();
    expect(screen.getByText('Logged in')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('Profile ready')).toBeTruthy();
    await waitFor(() => expect(countsOnPage()).toMatchObject({ 'Fresh jobs': '120', Eligible: '42', Applied: '18', Review: '2', Failed: '1', External: '5' }));
    // The run settings default to the profile: its locations and experience.
    expect(await screen.findByText(/All job profiles · Bangalore · Last 24 hours · 7 years \+ 6 months/)).toBeTruthy();
    expect(screen.getByText('No run is active.')).toBeTruthy();
  });

  it('says what the run is doing before it reaches the first job', () => {
    withProviders(<CurrentRun />);
    emit({ type: 'STATE', state: applying, timestamp: at }, runEvent('RUN_STARTED', 'Auto apply run started', { applicationId: undefined }));
    expect(screen.getByText('Searching Naukri…')).toBeTruthy();
    emit({ type: 'SEARCH_PROGRESS', runId: 'RUN-20260925-134500', found: 60, added: 45, timestamp: at });
    expect(screen.getByText('Searching Naukri… 60 jobs found, 45 new')).toBeTruthy();
    emit(runEvent('SEARCH_FINISHED', 'Search finished: 120 jobs found, 30 new', { applicationId: undefined }));
    expect(screen.getByText('Search finished: 120 jobs found, 30 new. Filtering…')).toBeTruthy();
    emit(runEvent('QUEUE_READY', '42 relevant, 25 eligible, 16 to apply to', { applicationId: undefined }));
    expect(screen.getByText('42 relevant, 25 eligible, 16 to apply to. Applying automatically…')).toBeTruthy();
  });

  it('follows the current job step by step, and names the next one', () => {
    withProviders(<CurrentRun />);
    emit(
      { type: 'STATE', state: applying, timestamp: at },
      runEvent('RUN_STARTED', 'Auto apply run started', { applicationId: undefined }),
      runEvent('JOB_STARTED', 'Started 18/42', { detail: { position: 18, total: 42, score: 91, nextCompany: 'Infosys', nextTitle: 'Frontend Developer' } }),
      runEvent('JOB_OPENED', 'Job opened'),
      runEvent('APPLY_BUTTON_FOUND', 'Apply button found'),
      runEvent('APPLY_CLICKED', 'Apply clicked'),
    );
    expect(screen.getByText('18 / 42')).toBeTruthy();
    expect(screen.getByText('Microsoft')).toBeTruthy();
    expect(screen.getByText('Senior React Developer')).toBeTruthy();
    expect(screen.getByText('Apply clicked')).toBeTruthy();
    expect(screen.getByText('Applying…')).toBeTruthy();
    expect(screen.getByText('Next: Infosys · Frontend Developer')).toBeTruthy();

    emit(runEvent('APPLICATION_CONFIRMED', 'Application confirmed: Naukri showed "You have successfully applied"', { status: 'APPLIED' }));
    expect(screen.getByText(/Application confirmed/)).toBeTruthy();
    expect(screen.getByText('Applied')).toBeTruthy();

    // The next job replaces the previous one's steps.
    emit(runEvent('JOB_STARTED', 'Started 19/42', { applicationId: 8, company: 'Infosys', detail: { position: 19, total: 42, score: 88 } }));
    expect(screen.getByText('19 / 42')).toBeTruthy();
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
    expect(screen.getByText('Review')).toBeTruthy();
    expect(screen.queryByText('Applied')).toBeNull();
  });
});

describe('apply page', () => {
  it('starts one run for the chosen profiles, locations, dates and experience, with no job to pick by hand', async () => {
    responses['POST /api/runs/start'] = { runId: 'RUN-20260925-134500' };
    withProviders(<ApplyPage />);
    emit({ type: 'STATE', state: idle, timestamp: at });

    await waitFor(() => expect(countsOnPage()).toMatchObject({ Found: '120', Eligible: '42', Applied: '18', Review: '2', Failed: '1', External: '5' }));
    expect(screen.getByText(/17 jobs to apply to now, freshest first/)).toBeTruthy();
    expect(screen.queryByLabelText(/maximum/i)).toBeNull();
    // The only checkbox is the Auto apply switch: no selecting jobs one by one.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getAllByRole('switch')).toHaveLength(1);

    fireEvent.click(await screen.findByRole('button', { name: 'React.js Developer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    const start = screen.getByRole('button', { name: 'Start auto apply' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-20' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-25' } });
    fireEvent.change(screen.getByLabelText('Experience (years)'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Tolerance'), { target: { value: '3' } });
    await waitFor(() =>
      expect(calls('GET /api/summary').at(-1)?.[0]).toContain(
        'profiles=react&locations=Bangalore%2CRemote&freshness=custom&tolerance=3&experience=8&from=2026-09-20&to=2026-09-25',
      ),
    );

    fireEvent.click(start);
    await waitFor(() => expect(calls('POST /api/runs/start')).toHaveLength(1));
    expect(JSON.parse(calls('POST /api/runs/start')[0]![1]!.body as string)).toEqual({
      scope: { profiles: ['react'], locations: ['Bangalore', 'Remote'], freshness: 'custom', from: '2026-09-20', to: '2026-09-25', experienceYears: 8, toleranceMonths: 3 },
      autoApply: true,
    });
  });

  it('asks for a profile before the first run', async () => {
    responses['GET /api/profile'] = { ...profile, profile: null, ready: false, source: null, problems: ['Set up your profile on the Profile page before starting.'] };
    withProviders(<ApplyPage />);
    expect(await screen.findByRole('link', { name: 'profile' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start auto apply' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts with auto apply on unless the switch is turned off, and never takes an old saved off', async () => {
    responses['POST /api/runs/start'] = { runId: 'RUN-20260925-134500' };
    // What an earlier version saved: the server's default, off, inside the other settings.
    localStorage.setItem('job-bot:settings', JSON.stringify({ profiles: [], locations: [], freshness: '24h', autoApply: false }));
    withProviders(<ApplyPage />);
    emit({ type: 'STATE', state: idle, timestamp: at });
    const toggle = (await screen.findByRole('switch')) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(screen.getByText('ON')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Start (check only)' }));
    await waitFor(() => expect(calls('POST /api/runs/start')).toHaveLength(1));
    expect(JSON.parse(calls('POST /api/runs/start')[0]![1]!.body as string)).toMatchObject({ autoApply: false });
    expect(localStorage.getItem('job-bot:auto-apply')).toBe('false');

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Start auto apply' }));
    await waitFor(() => expect(calls('POST /api/runs/start')).toHaveLength(2));
    expect(JSON.parse(calls('POST /api/runs/start')[1]![1]!.body as string)).toMatchObject({ autoApply: true });
    expect(localStorage.getItem('job-bot:auto-apply')).toBe('true');
  });

  it('shows whether the active run applies or only checks', () => {
    withProviders(<CurrentRun />);
    emit({ type: 'STATE', state: applying, timestamp: at }, runEvent('JOB_STARTED', 'Started 1/2', { detail: { position: 1, total: 2 } }));
    expect(screen.getByText('Auto apply ON')).toBeTruthy();
    expect(screen.getByText('Applying…')).toBeTruthy();
    emit({ type: 'STATE', state: { ...applying, activeRun: { ...applying.activeRun!, autoApply: false } }, timestamp: at });
    expect(screen.getByText('Auto apply OFF: checking jobs, not applying')).toBeTruthy();
    expect(screen.getByText('Checking…')).toBeTruthy();
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
  const job = (overrides: Partial<JobPage['jobs'][number]>): JobPage['jobs'][number] => ({
    id: 3,
    company: 'Infosys',
    title: 'React Developer',
    location: 'Bangalore',
    experience: '3-7 Yrs',
    postedAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
    score: 91,
    band: 'HIGH_MATCH',
    profiles: ['react'],
    jobStatus: 'SHORTLISTED',
    applicationStatus: null,
    category: 'ready',
    ineligibleReason: null,
    ...overrides,
  });

  it('lists jobs newest first with their experience, match and status, and why one is not eligible', async () => {
    responses['GET /api/jobs'] = {
      total: 2,
      jobs: [
        job({}),
        job({ id: 4, company: 'XYZ', title: 'Senior Engineer', experience: '10-15 Yrs', score: null, band: null, category: 'not_eligible', ineligibleReason: 'Requires 10+ years' }),
      ],
    } satisfies JobPage;
    withProviders(<JobsPage />);
    emit({ type: 'STATE', state: idle, timestamp: at });

    const cells = (text: string) => within(screen.getByText(text).closest('tr')!).getAllByRole('cell').map((cell) => cell.textContent);
    expect(await screen.findByText('React Developer')).toBeTruthy();
    expect(cells('React Developer')).toEqual(['Infosys', 'React Developer', 'Bangalore', '3-7 Yrs', '4h ago', '91', '○Ready to apply']);
    expect(cells('Senior Engineer')).toEqual(['XYZ', 'Senior Engineer', 'Bangalore', '10-15 Yrs', '4h ago', '-', '⊘Not eligibleRequires 10+ years']);
    await waitFor(() => expect(calls('GET /api/jobs').at(-1)?.[0]).toContain('experience=7'));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'not_eligible' } });
    await waitFor(() => expect(calls('GET /api/jobs').at(-1)?.[0]).toContain('status=not_eligible'));
    fireEvent.click(screen.getByText('Senior Engineer').closest('tr')!.querySelector('td')!);
    expect(push).toHaveBeenCalledWith('/jobs/4');
  });
});

describe('profile page', () => {
  it('loads the profile and saves it with the answers, dropping empty rows', async () => {
    responses['POST /api/profile'] = profile;
    withProviders(<ProfilePage />);
    const first = (await screen.findByLabelText('First name *')) as HTMLInputElement;
    await waitFor(() => expect(first.value).toBe('Test'));
    expect(screen.getByText('cv.pdf (20 KB)')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Years of experience *'), { target: { value: '7.5' } });
    fireEvent.change(screen.getByLabelText('Skills *'), { target: { value: 'React, TypeScript, Next.js' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(calls('POST /api/profile')).toHaveLength(1));
    const body = JSON.parse(calls('POST /api/profile')[0]![1]!.body as string);
    expect(body.profile).toMatchObject({ firstName: 'Test', experienceYears: 7.5, experienceToleranceMonths: 6, skills: ['React', 'TypeScript', 'Next.js'], resumeFile: 'cv.pdf' });
    expect(body.answers).toEqual([{ match: ['relocate'], answer: 'Yes' }]);
  });

  it('uploads a resume as JSON to the local server', async () => {
    responses['POST /api/profile/resume'] = { file: 'new-cv.pdf' };
    withProviders(<ProfilePage />);
    const input = (await screen.findByText('Replace resume')).querySelector('input')!;
    fireEvent.change(input, { target: { files: [new File(['%PDF-1.4'], 'new-cv.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(calls('POST /api/profile/resume')).toHaveLength(1));
    expect(JSON.parse(calls('POST /api/profile/resume')[0]![1]!.body as string)).toEqual({ name: 'new-cv.pdf', data: btoa('%PDF-1.4') });
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
        failureReason: 'No answer for this question in your profile or saved answers',
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
    let live = reduce(
      { connected: true, state: null, log: [], run: [], analysis: null, search: null, version: 0 },
      runEvent('RUN_STARTED', 'started', { applicationId: undefined }),
    );
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
