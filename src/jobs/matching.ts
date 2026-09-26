import type { DatabaseSync } from 'node:sqlite';
import { AiError, PROMPT_VERSION, analysisCacheKey, parseEvidence, type JobAnalysisProvider } from '../ai/analyzer.ts';
import type { MatchEvidence } from '../ai/schemas.ts';
import type { Env, JobProfile, Profile } from '../config.ts';
import type { AnalysisProgressEvent, JobScope } from '../domain.ts';
import { cachedEvidence, saveAnalysis } from '../db/analysis.ts';
import {
  allJobs,
  jobStatus,
  jobsToAnalyze,
  markAnalysisFailed,
  nextJobToMatch,
  setJobClassification,
  setMatchScore,
  updateJobStatus,
  type JobRow,
} from '../db/jobs.ts';
import { log } from '../logger.ts';
import { hardFilterReason, jobCities, matchingProfiles } from './filtering.ts';
import { bandFor, scoreMatch } from './scoring.ts';

// Sorts every job into the job profiles and cities it belongs to, and sets aside jobs relevant to no
// profile. Jobs set aside earlier are checked again, so edited profiles take effect at once.
export function applyHardFilters(db: DatabaseSync, jobProfiles: JobProfile[]): { rejected: number; kept: number } {
  let rejected = 0;
  let kept = 0;
  db.exec('BEGIN');
  try {
    for (const job of allJobs(db)) {
      const profiles = matchingProfiles(job, jobProfiles);
      const cities = jobCities(job);
      if (profiles.join() !== job.profiles.join() || cities.join() !== job.cities.join()) setJobClassification(db, job.id, { profiles, cities });
      if (job.status !== 'DISCOVERED' && !(job.status === 'SKIPPED' && job.filterReason)) continue;

      const reason = hardFilterReason(profiles);
      if (reason) {
        if (job.status === 'DISCOVERED') rejected++;
        if (reason !== job.filterReason) updateJobStatus(db, job.id, 'SKIPPED', { matchScore: null, filterReason: reason });
      } else {
        kept++;
        if (job.status === 'SKIPPED') updateJobStatus(db, job.id, 'DISCOVERED', { matchScore: null, filterReason: null });
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { rejected, kept };
}

export interface AnalysisSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  cacheHits: number;
  cacheMisses: number;
  // Average time of the analyses the model actually produced (cache hits excluded); null if none.
  averageMs: number | null;
  // False when every job was served from cache, so the model was never needed.
  modelChecked: boolean;
}

export type AnalysisProgress = Pick<AnalysisProgressEvent, 'done' | 'total' | 'jobTitle' | 'company' | 'score' | 'band' | 'error'>;

function analysisInput(job: JobRow, profile: Profile, provider: JobAnalysisProvider, jobProfiles: JobProfile[]) {
  const targetRoles = jobProfiles.filter((p) => job.profiles.includes(p.id)).map((p) => p.name);
  const input = { ...job, targetRoles, description: job.description ?? '' };
  return { input, cacheKey: analysisCacheKey(input, profile, provider) };
}

// Every described job not scored yet (with `force`, scored ones too), for `npm run analyze`.
export async function analyzeJobs(
  db: DatabaseSync,
  profile: Profile,
  env: Env,
  {
    provider,
    jobProfiles,
    force = false,
    scope,
    signal,
    onProgress,
  }: {
    provider: JobAnalysisProvider;
    jobProfiles: JobProfile[];
    force?: boolean;
    scope?: JobScope;
    signal?: AbortSignal;
    onProgress?: (progress: AnalysisProgress) => void;
  },
): Promise<AnalysisSummary> {
  const jobs = jobsToAnalyze(db, { force, scope }).map((job) => ({ job, ...analysisInput(job, profile, provider, jobProfiles) }));
  const summary: AnalysisSummary = { attempted: 0, succeeded: 0, failed: 0, cacheHits: 0, cacheMisses: 0, averageMs: null, modelChecked: false };
  if (!jobs.length) return summary;

  if (jobs.some(({ cacheKey }) => !cachedEvidence(db, cacheKey))) {
    await provider.ensureReady();
    summary.modelChecked = true;
  }
  log.info(`Analyzing ${jobs.length} job(s)...`);

  const modelTimes: number[] = [];
  // Identical descriptions (reposts) share one model request instead of each paying for it.
  const inFlight = new Map<string, Promise<MatchEvidence>>();
  let next = 0;
  let fatal: AiError | undefined;

  const report = (job: JobRow, score: number | null, error: string | null) =>
    onProgress?.({
      done: summary.succeeded + summary.failed,
      total: jobs.length,
      jobTitle: job.title,
      company: job.company,
      score,
      band: score === null ? null : bandFor(score),
      error,
    });

  // A stop request lets in-flight analyses finish and starts no new ones.
  const worker = async () => {
    while (!fatal && !signal?.aborted && next < jobs.length) {
      const { job, input, cacheKey } = jobs[next++]!;
      const started = Date.now();
      const cached = parseEvidence(cachedEvidence(db, cacheKey));
      let request = inFlight.get(cacheKey);
      const reused = 'evidence' in cached || request !== undefined;
      if (!reused) {
        request = provider.analyze(input, profile);
        inFlight.set(cacheKey, request);
      }

      try {
        const evidence = 'evidence' in cached ? cached.evidence : await request!;
        const score = recordAnalysis(db, job, profile, env, provider, cacheKey, evidence, jobProfiles);
        summary.succeeded++;
        if (reused) summary.cacheHits++;
        else {
          summary.cacheMisses++;
          modelTimes.push(Date.now() - started);
        }
        const source = reused ? '✓ Cached evidence' : `✓ Evidence generated (${((Date.now() - started) / 1_000).toFixed(1)}s)`;
        log.info(`[${summary.succeeded + summary.failed}/${jobs.length}] ${job.title} · ${job.company}`);
        log.info(`       ${source} ✓ Schema valid ✓ Score: ${score} ${bandFor(score).replace('_', ' ')}`);
        report(job, score, null);
      } catch (err) {
        if (err instanceof AiError && err.fatal) {
          fatal = err;
          return;
        }
        summary.failed++;
        if (!reused) summary.cacheMisses++;
        const message = (err as Error).message;
        markAnalysisFailed(db, job.id, message);
        log.info(`[${summary.succeeded + summary.failed}/${jobs.length}] ${job.title} · ${job.company}`);
        log.warn(`       ✗ Analysis failed: ${message}`);
        report(job, null, message);
      } finally {
        summary.attempted++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(env.AI_CONCURRENCY, jobs.length) }, worker));
  if (fatal) throw fatal;

  summary.averageMs = modelTimes.length ? modelTimes.reduce((a, b) => a + b, 0) / modelTimes.length : null;
  return summary;
}

// Scores eligible jobs one at a time while a run applies, so the AI never holds up searching or
// applying. Unrelated jobs never reach it, a job is never scored twice, and it stops with the run.
export async function matchInBackground(
  db: DatabaseSync,
  profile: Profile,
  env: Env,
  { provider, jobProfiles, scope, signal }: { provider: JobAnalysisProvider; jobProfiles: JobProfile[]; scope: JobScope; signal: AbortSignal },
): Promise<{ matched: number; failed: number }> {
  let matched = 0;
  let failed = 0;
  let checked = false;
  try {
    while (!signal.aborted) {
      const job = nextJobToMatch(db, scope);
      if (!job) break;
      const { input, cacheKey } = analysisInput(job, profile, provider, jobProfiles);
      const cached = parseEvidence(cachedEvidence(db, cacheKey));
      try {
        if (!('evidence' in cached) && !checked) {
          await provider.ensureReady();
          checked = true;
        }
        const evidence = 'evidence' in cached ? cached.evidence : await provider.analyze(input, profile, signal);
        const score = recordAnalysis(db, job, profile, env, provider, cacheKey, evidence, jobProfiles);
        matched++;
        log.info(`AI match ${score}: ${job.title} · ${job.company}`);
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof AiError && err.fatal) {
          log.warn(`AI matching is off for this run: ${err.message.split('\n')[0]}`);
          break;
        }
        failed++;
        markAnalysisFailed(db, job.id, (err as Error).message);
        log.warn(`AI match failed for ${job.title} · ${job.company}: ${(err as Error).message}`);
      }
    }
  } finally {
    if (checked) await provider.release?.();
  }
  return { matched, failed };
}

function recordAnalysis(
  db: DatabaseSync,
  job: JobRow,
  profile: Profile,
  env: Env,
  provider: JobAnalysisProvider,
  cacheKey: string,
  evidence: MatchEvidence,
  jobProfiles: JobProfile[],
): number {
  const own = jobProfiles.filter((p) => job.profiles.includes(p.id));
  const result = scoreMatch({ evidence, job, profile, minMatchScore: env.MIN_MATCH_SCORE, jobProfiles: own });
  db.exec('BEGIN');
  try {
    saveAnalysis(db, {
      jobId: job.id,
      cacheKey,
      provider: provider.name,
      model: provider.model,
      promptVersion: PROMPT_VERSION,
      evidence: JSON.stringify(evidence),
      result,
    });
    // The run may have applied to the job while the model worked on it; that status stays.
    if (jobStatus(db, job.id) === 'APPLIED') setMatchScore(db, job.id, result.score);
    else updateJobStatus(db, job.id, result.status, { matchScore: result.score, filterReason: null });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result.score;
}
