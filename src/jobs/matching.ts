import type { DatabaseSync } from 'node:sqlite';
import { AiError, PROMPT_VERSION, analysisCacheKey, parseEvidence, type JobAnalysisProvider } from '../ai/analyzer.ts';
import type { MatchEvidence } from '../ai/schemas.ts';
import type { Env, Profile } from '../config.ts';
import { cachedEvidence, saveAnalysis } from '../db/analysis.ts';
import { jobsToAnalyze, jobsToFilter, updateJobStatus, type JobRow } from '../db/jobs.ts';
import { log } from '../logger.ts';
import { hardFilterReason } from './filtering.ts';
import { bandFor, scoreMatch } from './scoring.ts';

export function applyHardFilters(db: DatabaseSync, profile: Profile, { recheck = false } = {}): { rejected: number; kept: number } {
  let rejected = 0;
  let kept = 0;
  for (const job of jobsToFilter(db, recheck)) {
    const reason = hardFilterReason(job, profile);
    if (reason) {
      rejected++;
      updateJobStatus(db, job.id, 'SKIPPED', { matchScore: null, filterReason: reason });
      log.debug(`Filtered out: ${job.title} at ${job.company}. ${reason}`);
    } else {
      kept++;
      if (job.status === 'SKIPPED') updateJobStatus(db, job.id, 'DISCOVERED', { matchScore: null, filterReason: null });
    }
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

export async function analyzeJobs(
  db: DatabaseSync,
  profile: Profile,
  env: Env,
  { provider, force = false }: { provider: JobAnalysisProvider; force?: boolean },
): Promise<AnalysisSummary> {
  const jobs = jobsToAnalyze(db, force, env.MAX_JOBS_PER_RUN).map((job) => {
    const input = { ...job, description: job.description ?? '' };
    return { job, input, cacheKey: analysisCacheKey(input, profile, provider) };
  });
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

  const worker = async () => {
    while (!fatal && next < jobs.length) {
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
        const score = recordAnalysis(db, job, profile, env, provider, cacheKey, evidence);
        summary.succeeded++;
        if (reused) summary.cacheHits++;
        else {
          summary.cacheMisses++;
          modelTimes.push(Date.now() - started);
        }
        const source = reused ? '✓ Cached evidence' : `✓ Evidence generated (${((Date.now() - started) / 1_000).toFixed(1)}s)`;
        log.info(`[${summary.succeeded + summary.failed}/${jobs.length}] ${job.title} · ${job.company}`);
        log.info(`       ${source} ✓ Schema valid ✓ Score: ${score} ${bandFor(score).replace('_', ' ')}`);
      } catch (err) {
        if (err instanceof AiError && err.fatal) {
          fatal = err;
          return;
        }
        summary.failed++;
        if (!reused) summary.cacheMisses++;
        const message = (err as Error).message;
        // A failed re-analysis keeps the job's earlier verdict; only unscored jobs are marked failed.
        if (job.status === 'DISCOVERED' || job.status === 'ANALYSIS_FAILED') {
          updateJobStatus(db, job.id, 'ANALYSIS_FAILED', { matchScore: null, filterReason: null, analysisError: message });
        }
        log.info(`[${summary.succeeded + summary.failed}/${jobs.length}] ${job.title} · ${job.company}`);
        log.warn(`       ✗ Analysis failed: ${message}`);
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

function recordAnalysis(
  db: DatabaseSync,
  job: JobRow,
  profile: Profile,
  env: Env,
  provider: JobAnalysisProvider,
  cacheKey: string,
  evidence: MatchEvidence,
): number {
  const result = scoreMatch({ evidence, job, profile, minMatchScore: env.MIN_MATCH_SCORE });
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
    updateJobStatus(db, job.id, result.status, { matchScore: result.score, filterReason: null });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result.score;
}
