import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createProvider } from './ai/providers.ts';
import {
  ConfigError,
  DEFAULT_DIRS,
  MAX_RESUME_BYTES,
  answersSchema,
  loadAnswers,
  loadUserProfile,
  matchProfile,
  resumeInfo,
  saveAnswers,
  saveResume,
  saveUserProfile,
  type Dirs,
  type Env,
  type LoadedProfile,
} from './config.ts';
import { BotControl, Busy } from './control.ts';
import { getApplication, listApplications, scopeSummary } from './db/applications.ts';
import { getJobDetail, listJobs } from './db/jobs.ts';
import { getRun, listRuns, runEvents } from './db/runs.ts';
import {
  CATEGORY_LABELS,
  FRESHNESS,
  RUN_KINDS,
  type BotEvent,
  type JobCategory,
  type JobProfileSummary,
  type JobScope,
  type ProfileResponse,
  type ScopeSummary,
  type StatusResponse,
} from './domain.ts';
import { events, formatSse, publish } from './events.ts';
import { isAnsweredBy } from './jobs/applying.ts';
import { loadApplicationConfig } from './jobs/runs.ts';
import { log, onLog } from './logger.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');
const scopeSchema = z
  .strictObject({
    profiles: z.array(z.string()).max(50).default([]),
    locations: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    freshness: z.enum(FRESHNESS).default('24h'),
    from: day.nullable().default(null),
    to: day.nullable().default(null),
    experienceYears: z.number().min(0).max(60).nullable().default(null),
    toleranceMonths: z.number().int().min(0).max(60).default(6),
  })
  .refine((s) => !s.from || !s.to || s.from <= s.to, { message: 'The date range ends before it starts', path: ['to'] });
const startSchema = z.strictObject({ scope: scopeSchema, autoApply: z.boolean() });
const profileSchema = z.strictObject({ profile: z.unknown(), answers: z.unknown() });
const resumeSchema = z.strictObject({ name: z.string().min(1).max(200), data: z.base64() });
const CATEGORIES: (JobCategory | 'all')[] = ['all', ...(Object.keys(CATEGORY_LABELS) as JobCategory[])];

// Only this machine: a page on another site can't reach the API through the user's browser
// (Host check against DNS rebinding, Origin check, JSON-only writes so forms can't post).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function guard(req: IncomingMessage): void {
  if (!LOCAL_HOST.test(req.headers.host ?? '')) throw new HttpError(403, 'Only local requests are accepted');
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin)) throw new HttpError(403, 'Cross-site requests are not accepted');
  if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'POST bodies must be JSON');
  }
}

async function readJson(req: IncomingMessage, limit = 65_536): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, 'Request body too large');
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  const value = raw === null || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
  return value;
}

// ?profiles=react,angular&locations=Bangalore,Remote&freshness=custom&from=2026-09-20&to=2026-09-26&experience=7&tolerance=6
function scopeParam(url: URL): JobScope {
  const list = (name: string) => url.searchParams.get(name)?.split(',').filter(Boolean) ?? [];
  const number = (name: string) => {
    const raw = url.searchParams.get(name);
    return raw === null || raw === '' ? undefined : Number(raw);
  };
  return parse(scopeSchema, {
    profiles: list('profiles'),
    locations: list('locations'),
    freshness: url.searchParams.get('freshness') ?? undefined,
    from: url.searchParams.get('from') || null,
    to: url.searchParams.get('to') || null,
    experienceYears: number('experience') ?? null,
    toleranceMonths: number('tolerance'),
  });
}

function orElse<T, F>(load: () => T, fallback: F): T | F {
  try {
    return load();
  } catch (err) {
    if (err instanceof ConfigError) return fallback;
    throw err;
  }
}

const RECENT_LIMIT = 300;

export function createApi({ control, db, env, dirs = DEFAULT_DIRS }: { control: BotControl; db: DatabaseSync; env: Env; dirs?: Dirs }): Server {
  onLog((level, message) => publish({ type: 'LOG', level, message, runId: control.state.activeRun?.id, timestamp: new Date().toISOString() }));

  // Replayed to each new dashboard tab so it shows the current run's story, not a blank page.
  const recent: BotEvent[] = [];
  events.setMaxListeners(50);
  events.on('event', (event) => {
    if (event.type === 'STATE' || event.type === 'SEARCH_PROGRESS') return;
    recent.push(event);
    if (recent.length > RECENT_LIMIT) recent.shift();
  });

  const profileState = (): ProfileResponse => {
    let loaded: LoadedProfile | null = null;
    const problems: string[] = [];
    try {
      loaded = loadUserProfile(dirs);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      problems.push(err.message);
    }
    const answers = orElse(() => loadAnswers(dirs), []);
    const resume = resumeInfo(loaded?.resumePath ?? null);
    const p = loaded?.profile;
    if (!loaded && !problems.length) problems.push('Set up your profile on the Profile page before starting.');
    if (p && !p.email) problems.push('No email in your profile: forms that ask for it go to Review.');
    if (p && !p.phone) problems.push('No phone number in your profile: forms that ask for it go to Review.');
    if (p && !resume) problems.push('No resume uploaded: forms that ask for one go to Review.');
    if (p && !answers.length) problems.push('No saved application answers: recruiter questions only get answers your profile covers.');
    if (loaded?.source === 'legacy') problems.push('Your profile is read from the older config/ files. Save it once on the Profile page to move it to data/.');
    return {
      profile: p ?? null,
      answers,
      resume,
      source: loaded?.source ?? null,
      ready: Boolean(loaded),
      problems,
      defaults: {
        autoApply: env.AUTO_APPLY,
        locations: p ? matchProfile(p).preferredLocations : [],
        experienceYears: p?.experienceYears ?? null,
        toleranceMonths: p?.experienceToleranceMonths ?? 6,
      },
    };
  };

  const summary = (scope: JobScope): ScopeSummary => {
    const { answers, facts } = orElse(() => loadApplicationConfig(dirs), { answers: [], facts: null });
    return {
      ...scopeSummary(db, { scope, minMatchScore: env.MIN_MATCH_SCORE, isAnswered: isAnsweredBy(answers, facts) }),
      minMatchScore: env.MIN_MATCH_SCORE,
      problems: profileState().problems,
    };
  };

  function streamEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform keeps proxies (the dashboard's dev server) from compressing and buffering the stream.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write(formatSse({ type: 'STATE', state: control.state, timestamp: new Date().toISOString() }));
    for (const event of recent) res.write(formatSse(event));
    const forward = (event: BotEvent) => res.write(formatSse(event));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    events.on('event', forward);
    req.on('close', () => {
      clearInterval(ping);
      events.off('event', forward);
    });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    guard(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');
    const runId = path.match(/^\/api\/runs\/(RUN-[\w-]+)$/)?.[1];
    const id = runId ? undefined : path.match(/\/(\d+)$/)?.[1];
    const key = `${req.method} ${runId ? '/api/runs/:id' : id ? path.replace(/\d+$/, ':id') : path}`;

    switch (key) {
      case 'GET /api/health':
        return send(res, 200, { ok: true });
      case 'GET /api/events':
        return streamEvents(req, res);
      case 'GET /api/status': {
        const provider = createProvider(env);
        const body: StatusResponse = {
          state: control.state,
          ai: { provider: provider.label, model: provider.model },
          profileReady: profileState().ready,
          lastRun: listRuns(db, { kind: 'APPLY', limit: 1 })[0] ?? null,
        };
        return send(res, 200, body);
      }
      case 'GET /api/profiles':
        return send(res, 200, control.jobProfiles().map(({ id, name }): JobProfileSummary => ({ id, name })));

      case 'GET /api/profile':
        return send(res, 200, profileState());
      case 'POST /api/profile': {
        const body = parse(profileSchema, await readJson(req));
        const answers = parse(answersSchema, body.answers);
        saveUserProfile(body.profile, dirs);
        saveAnswers(answers, dirs);
        return send(res, 200, profileState());
      }
      case 'POST /api/profile/resume': {
        const { name, data } = parse(resumeSchema, await readJson(req, Math.ceil((MAX_RESUME_BYTES * 4) / 3) + 1_024));
        const file = saveResume(name, Buffer.from(data, 'base64'), dirs);
        const loaded = orElse(() => loadUserProfile(dirs), null);
        if (loaded?.source === 'data') saveUserProfile({ ...loaded.profile, resumeFile: file }, dirs);
        return send(res, 200, { file });
      }

      case 'POST /api/browser/start':
        await control.startBrowser();
        return send(res, 200, control.state);
      case 'POST /api/browser/stop':
        await control.stopBrowser();
        return send(res, 200, control.state);
      case 'POST /api/session/check':
        return send(res, 200, { session: await control.checkSession() });
      case 'POST /api/session/login':
        control.startLogin();
        return send(res, 202, control.state);

      case 'GET /api/summary':
        return send(res, 200, summary(scopeParam(url)));
      case 'GET /api/jobs': {
        const category = (url.searchParams.get('status') ?? 'all') as JobCategory | 'all';
        if (!CATEGORIES.includes(category)) throw new HttpError(400, `status must be one of ${CATEGORIES.join(', ')}`);
        return send(
          res,
          200,
          listJobs(db, {
            scope: scopeParam(url),
            minMatchScore: env.MIN_MATCH_SCORE,
            category,
            limit: intParam(url, 'limit', 100, 1, 500),
            offset: intParam(url, 'offset', 0, 0, 10_000_000),
          }),
        );
      }
      case 'GET /api/jobs/:id': {
        const job = getJobDetail(db, Number(id), { scope: scopeParam(url), minMatchScore: env.MIN_MATCH_SCORE });
        if (!job) throw new HttpError(404, `No job ${id}`);
        return send(res, 200, { ...job, applications: listApplications(db, { jobId: job.id }) });
      }
      case 'GET /api/applications/:id': {
        const application = getApplication(db, Number(id));
        if (!application) throw new HttpError(404, `No application ${id}`);
        return send(res, 200, { ...application, events: runEvents(db, { applicationId: application.id }) });
      }

      case 'POST /api/runs/start': {
        const { scope, autoApply } = parse(startSchema, await readJson(req));
        return send(res, 202, { runId: await control.startAutoApply({ ...scope, autoApply }) });
      }
      case 'GET /api/runs': {
        const kind = url.searchParams.get('kind') ?? undefined;
        if (kind && !(RUN_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of ${RUN_KINDS.join(', ')}`);
        return send(res, 200, listRuns(db, { kind: kind as (typeof RUN_KINDS)[number] | undefined, limit: intParam(url, 'limit', 100, 1, 1000) }));
      }
      case 'GET /api/runs/:id': {
        const run = getRun(db, runId!);
        if (!run) throw new HttpError(404, `No run ${runId}`);
        // The latest attempts first; ?limit keeps a live page from refetching a thousand rows per job.
        const limit = intParam(url, 'limit', -1, -1, 100_000);
        return send(res, 200, { ...run, applications: listApplications(db, { runId: run.id, limit }), events: runEvents(db, { runId: run.id }) });
      }
      case 'POST /api/runs/pause':
        if (!control.pauseRun()) throw new HttpError(409, 'No run to pause');
        return send(res, 202, control.state);
      case 'POST /api/runs/resume':
        if (!control.resumeRun()) throw new HttpError(409, 'No paused run to resume');
        return send(res, 202, control.state);
      case 'POST /api/runs/stop':
        if (!control.stopRun()) throw new HttpError(409, 'No run is active');
        return send(res, 202, control.state);

      default:
        throw new HttpError(404, `No route for ${req.method} ${url.pathname}`);
    }
  }

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : err instanceof Busy ? 409 : err instanceof ConfigError ? 400 : 500;
      if (status === 500) log.error(`${req.method} ${req.url} failed`, err);
      if (res.headersSent) return res.end();
      send(res, status, { error: (err as Error).message });
    });
  });
}
