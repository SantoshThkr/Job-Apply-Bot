import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createProvider } from './ai/providers.ts';
import { ConfigError, loadAnswers, loadJobProfiles, loadProfile, loadResume, paths, type Env } from './config.ts';
import { BotControl, Busy } from './control.ts';
import { applicationSummary, dashboardCounts, getApplication, listApplications } from './db/applications.ts';
import { getJobDetail, listJobs } from './db/jobs.ts';
import { getRun, listRuns, runEvents } from './db/runs.ts';
import {
  FRESHNESS,
  RUN_KINDS,
  type ApplicationSummary,
  type BotEvent,
  type JobCategory,
  type JobProfileSummary,
  type JobScope,
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

const scopeSchema = z.strictObject({
  profiles: z.array(z.string()).max(50).default([]),
  freshness: z.enum(FRESHNESS).default('all'),
});
const applySchema = scopeSchema.extend({ autoApply: z.boolean() });
const CATEGORIES: (JobCategory | 'all')[] = ['all', 'ready', 'applying', 'applied', 'failed', 'external', 'review', 'already_applied', 'new', 'low_match', 'filtered'];

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

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 65_536) throw new HttpError(413, 'Request body too large');
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

// ?profiles=react,angular&freshness=24h
function scopeParam(url: URL): JobScope {
  return parse(scopeSchema, {
    profiles: url.searchParams.get('profiles')?.split(',').filter(Boolean) ?? [],
    freshness: url.searchParams.get('freshness') ?? 'all',
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

// Config problems stated up front, so the Apply page can say what is missing before a run needs it.
function configProblems(dir: string): string[] {
  const problems: string[] = [];
  const check = (load: () => unknown) => {
    try {
      load();
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      problems.push(err.message);
    }
  };
  check(() => loadProfile(dir));
  check(() => loadJobProfiles(dir));
  if (existsSync(join(dir, 'resume.json'))) check(() => loadResume(dir));
  else problems.push('config/resume.json not found: forms that ask for a resume or contact details go to review.');
  if (existsSync(join(dir, 'answers.json'))) check(() => loadAnswers(dir));
  else problems.push('config/answers.json not found: recruiter questions only get answers your profile covers.');
  return problems;
}

const RECENT_LIMIT = 300;

export function createApi({
  control,
  db,
  env,
  configDir = paths.config,
}: {
  control: BotControl;
  db: DatabaseSync;
  env: Env;
  configDir?: string;
}): Server {
  onLog((level, message) => publish({ type: 'LOG', level, message, runId: control.state.activeRun?.id, timestamp: new Date().toISOString() }));

  // Replayed to each new dashboard tab so it shows the current run's story, not a blank page.
  const recent: BotEvent[] = [];
  events.setMaxListeners(50);
  events.on('event', (event) => {
    if (event.type === 'STATE') return;
    recent.push(event);
    if (recent.length > RECENT_LIMIT) recent.shift();
  });

  const summary = (scope: JobScope): ApplicationSummary => {
    const { answers, facts } = orElse(() => loadApplicationConfig(configDir, orElse(() => loadProfile(configDir), null)), { answers: [], facts: null });
    return {
      ...applicationSummary(db, { scope, minMatchScore: env.MIN_MATCH_SCORE, isAnswered: isAnsweredBy(answers, facts) }),
      minMatchScore: env.MIN_MATCH_SCORE,
      autoApply: env.AUTO_APPLY,
      problems: configProblems(configDir),
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
          counts: dashboardCounts(db),
          lastRun: listRuns(db, { kind: 'APPLY', limit: 1 })[0] ?? null,
        };
        return send(res, 200, body);
      }
      case 'GET /api/profiles':
        return send(res, 200, control.jobProfiles().map(({ id, name }): JobProfileSummary => ({ id, name })));

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

      case 'GET /api/jobs': {
        const category = (url.searchParams.get('status') ?? 'all') as JobCategory | 'all';
        if (!CATEGORIES.includes(category)) throw new HttpError(400, `status must be one of ${CATEGORIES.join(', ')}`);
        return send(
          res,
          200,
          listJobs(db, {
            scope: scopeParam(url),
            category,
            limit: intParam(url, 'limit', 100, 1, 500),
            offset: intParam(url, 'offset', 0, 0, 10_000_000),
          }),
        );
      }
      case 'GET /api/jobs/:id': {
        const job = getJobDetail(db, Number(id));
        if (!job) throw new HttpError(404, `No job ${id}`);
        return send(res, 200, { ...job, applications: listApplications(db, { jobId: job.id }) });
      }
      case 'POST /api/jobs/search':
        return send(res, 202, { runId: await control.startSearch(parse(scopeSchema, await readJson(req))) });

      case 'GET /api/applications/summary':
        return send(res, 200, summary(scopeParam(url)));
      case 'POST /api/applications/start':
        return send(res, 202, { runId: await control.startApplications(parse(applySchema, await readJson(req))) });
      case 'GET /api/applications/:id': {
        const application = getApplication(db, Number(id));
        if (!application) throw new HttpError(404, `No application ${id}`);
        return send(res, 200, { ...application, events: runEvents(db, { applicationId: application.id }) });
      }

      case 'GET /api/runs': {
        const kind = url.searchParams.get('kind') ?? undefined;
        if (kind && !(RUN_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of ${RUN_KINDS.join(', ')}`);
        return send(res, 200, listRuns(db, { kind: kind as (typeof RUN_KINDS)[number] | undefined, limit: intParam(url, 'limit', 100, 1, 1000) }));
      }
      case 'GET /api/runs/:id': {
        const run = getRun(db, runId!);
        if (!run) throw new HttpError(404, `No run ${runId}`);
        return send(res, 200, { ...run, applications: listApplications(db, { runId: run.id }), events: runEvents(db, { runId: run.id }) });
      }
      case 'POST /api/runs/pause':
        if (!control.pauseRun()) throw new HttpError(409, 'No application run to pause');
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
