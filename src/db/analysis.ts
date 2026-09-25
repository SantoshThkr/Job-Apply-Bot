import type { DatabaseSync } from 'node:sqlite';
import type { MatchBand, MatchResult } from '../jobs/scoring.ts';
import type { JobStatus } from './jobs.ts';

export function cachedEvidence(db: DatabaseSync, cacheKey: string): string | undefined {
  const row = db
    .prepare('SELECT evidence FROM job_analysis WHERE cache_key = ? ORDER BY id DESC LIMIT 1')
    .get(cacheKey) as { evidence: string } | undefined;
  return row?.evidence;
}

export function saveAnalysis(
  db: DatabaseSync,
  analysis: {
    jobId: number;
    cacheKey: string;
    provider: string;
    model: string;
    promptVersion: string;
    evidence: string;
    result: MatchResult;
  },
  now = new Date(),
): void {
  const { result } = analysis;
  db.prepare(
    `INSERT INTO job_analysis (
       job_id, cache_key, provider, model, prompt_version, evidence, score, recommendation,
       matched_skills, missing_skills, red_flags, reason, breakdown, analyzed_at
     ) VALUES (
       :jobId, :cacheKey, :provider, :model, :promptVersion, :evidence, :score, :recommendation,
       :matchedSkills, :missingSkills, :redFlags, :reason, :breakdown, :now
     )`,
  ).run({
    jobId: analysis.jobId,
    cacheKey: analysis.cacheKey,
    provider: analysis.provider,
    model: analysis.model,
    promptVersion: analysis.promptVersion,
    evidence: analysis.evidence,
    score: result.score,
    recommendation: result.band,
    matchedSkills: JSON.stringify(result.matchedSkills),
    missingSkills: JSON.stringify(result.missingSkills),
    redFlags: JSON.stringify(result.redFlags),
    reason: result.reason,
    breakdown: JSON.stringify({
      ...result.breakdown,
      missingPreferredSkills: result.missingPreferredSkills,
      holdReason: result.holdReason,
    }),
    now: now.toISOString(),
  });
}

export interface RankedJob {
  id: number;
  title: string;
  company: string;
  location: string | null;
  url: string;
  status: JobStatus;
  score: number;
  band: MatchBand;
  reason: string;
  matchedSkills: string[];
  missingSkills: string[];
  redFlags: string[];
  holdReason: string | null;
}

// Each job's latest analysis, best first.
export function rankedJobs(db: DatabaseSync, statuses: JobStatus[], limit: number): RankedJob[] {
  const rows = db
    .prepare(
      `SELECT j.id, j.title, j.company, j.location, j.url, j.status, a.score, a.recommendation AS band, a.reason,
              a.matched_skills AS matchedSkills, a.missing_skills AS missingSkills, a.red_flags AS redFlags,
              a.breakdown ->> '$.holdReason' AS holdReason
       FROM jobs j
       JOIN job_analysis a ON a.id = (SELECT max(id) FROM job_analysis WHERE job_id = j.id)
       WHERE j.status IN (SELECT value FROM json_each(:statuses))
       ORDER BY a.score DESC, j.id
       LIMIT :limit`,
    )
    .all({ statuses: JSON.stringify(statuses), limit }) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...(row as unknown as RankedJob),
    matchedSkills: JSON.parse(row.matchedSkills as string),
    missingSkills: JSON.parse(row.missingSkills as string),
    redFlags: JSON.parse(row.redFlags as string),
  }));
}

export function matchCounts(db: DatabaseSync): {
  analyzed: number;
  highMatches: number;
  shortlisted: number;
  review: number;
  skippedByAi: number;
  skippedByFilter: number;
  analysisFailed: number;
} {
  return db
    .prepare(
      `SELECT
         count(*) FILTER (WHERE match_score IS NOT NULL) AS analyzed,
         count(*) FILTER (WHERE match_score >= 90) AS highMatches,
         count(*) FILTER (WHERE status = 'SHORTLISTED') AS shortlisted,
         count(*) FILTER (WHERE status = 'REVIEW') AS review,
         count(*) FILTER (WHERE status = 'SKIPPED' AND filter_reason IS NULL) AS skippedByAi,
         count(*) FILTER (WHERE status = 'SKIPPED' AND filter_reason IS NOT NULL) AS skippedByFilter,
         count(*) FILTER (WHERE status = 'ANALYSIS_FAILED') AS analysisFailed
       FROM jobs`,
    )
    .get() as ReturnType<typeof matchCounts>;
}
