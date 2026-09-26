import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiError } from '../src/ai/analyzer.ts';
import { loadEnv } from '../src/config.ts';
import { rankedJobs } from '../src/db/analysis.ts';
import { openDatabase } from '../src/db/database.ts';
import { insertJob, jobsNeedingDetails, saveJobDetails, setJobClassification } from '../src/db/jobs.ts';
import { jobCities, matchingProfiles } from '../src/jobs/filtering.ts';
import { analyzeJobs, applyHardFilters, matchInBackground } from '../src/jobs/matching.ts';
import { normalizeCard } from '../src/jobs/normalization.ts';
import { evidence, fakeProvider, skills, testJobProfiles, testProfile } from './fixtures.ts';

const env = loadEnv({});
let db: DatabaseSync;

function addJob(id: string, title: string, company: string, description: string | null) {
  const card = normalizeCard({
    externalId: id,
    url: `https://www.naukri.com/job-listings-x-${id}`,
    title,
    company,
    location: 'Hybrid - Bengaluru',
    experience: '5-10 Yrs',
  });
  insertJob(db, card!, 'test');
  const row = db.prepare('SELECT id FROM jobs WHERE external_id = ?').get(id) as { id: number };
  // Sorted into profiles the way every search does before anything is analyzed.
  setJobClassification(db, row.id, { profiles: matchingProfiles(card!, testJobProfiles), cities: jobCities(card!) });
  if (description) saveJobDetails(db, row.id, { description, skills: [], employmentType: null, postedAt: null, workMode: null });
  return row.id;
}

const statusOf = (id: number) => db.prepare('SELECT status, match_score, filter_reason, analysis_error FROM jobs WHERE id = ?').get(id);

// Strong evidence for RAG postings, weak for everything else.
const answer = (description: string) =>
  description.includes('RAG')
    ? evidence({ requiredSkills: skills(['Python', 'Python'], ['RAG', 'RAG']), reason: 'Python and RAG match.' })
    : evidence({ roleRelevance: 'WEAK', aiFocus: 'NONE', requiredSkills: skills(['Java', null]), reason: 'Java role.' });

beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
});

describe('matching pipeline', () => {
  it('filters, analyzes once per unique description, and scores', async () => {
    const original = addJob('100000000001', 'AI Engineer', 'Acme', 'Build RAG services in Python.');
    const repost = addJob('100000000002', 'AI Engineer', 'Acme Labs', 'Build RAG services in Python.');
    const javaRole = addJob('100000000003', 'Full Stack Engineer', 'Beta', 'Java and Spring Boot microservices.');
    const offTopic = addJob('100000000004', 'Data Engineer', 'Gamma', 'Spark pipelines.');
    const noDescription = addJob('100000000005', 'Senior React Developer', 'Delta', null);

    expect(applyHardFilters(db, testJobProfiles)).toEqual({ rejected: 1, kept: 4 });
    expect(statusOf(offTopic)).toMatchObject({ status: 'SKIPPED', filter_reason: 'Title matches none of your job profiles' });

    const provider = fakeProvider(answer);
    const summary = await analyzeJobs(db, testProfile, env, { provider, jobProfiles: testJobProfiles });

    expect(summary).toMatchObject({ attempted: 3, succeeded: 3, failed: 0, cacheHits: 1, cacheMisses: 2, modelChecked: true });
    expect(provider.calls).toEqual(['AI Engineer', 'Full Stack Engineer']);
    expect(statusOf(original)).toMatchObject({ status: 'SHORTLISTED', match_score: 100 });
    expect(statusOf(repost)).toMatchObject({ status: 'SHORTLISTED', match_score: 100 });
    expect(statusOf(javaRole)).toMatchObject({ status: 'SKIPPED', filter_reason: null });
    expect(statusOf(noDescription)).toMatchObject({ status: 'DISCOVERED' });
    expect(jobsNeedingDetails(db, { limit: 10 }).map((j) => j.id)).toEqual([noDescription]);

    const [best] = rankedJobs(db, ['SHORTLISTED'], 5);
    expect(best).toMatchObject({ score: 100, band: 'HIGH_MATCH', matchedSkills: ['Python', 'RAG'], missingSkills: [], holdReason: null });
    expect(db.prepare('SELECT DISTINCT provider, model FROM job_analysis').all()).toEqual([{ provider: 'ollama', model: 'test-model' }]);
  });

  it('serves repeat runs from the cache without checking or calling the model', async () => {
    addJob('100000000001', 'AI Engineer', 'Acme', 'Build RAG services in Python.');
    const provider = fakeProvider(answer);
    await analyzeJobs(db, testProfile, env, { provider, jobProfiles: testJobProfiles });

    expect(await analyzeJobs(db, testProfile, env, { provider, jobProfiles: testJobProfiles })).toMatchObject({ attempted: 0 });
    const forced = await analyzeJobs(db, testProfile, env, { provider, force: true, jobProfiles: testJobProfiles });
    expect(forced).toMatchObject({ attempted: 1, cacheHits: 1, cacheMisses: 0, averageMs: null, modelChecked: false });
    expect(provider.calls).toHaveLength(1);
    expect(provider.readyChecks).toBe(1);
  });

  it('never reuses another provider or model’s evidence', async () => {
    addJob('100000000001', 'AI Engineer', 'Acme', 'Build RAG services in Python.');
    await analyzeJobs(db, testProfile, env, { provider: fakeProvider(answer, { name: 'openai', model: 'gpt-5-mini' }), jobProfiles: testJobProfiles });

    const local = fakeProvider(answer);
    const summary = await analyzeJobs(db, testProfile, env, { provider: local, force: true, jobProfiles: testJobProfiles });
    expect(summary).toMatchObject({ cacheHits: 0, cacheMisses: 1 });
    expect(local.calls).toHaveLength(1);
  });

  it('marks a job ANALYSIS_FAILED when no valid evidence arrives and carries on', async () => {
    const broken = addJob('100000000001', 'AI Engineer', 'Acme', 'Build RAG services in Python. BROKEN');
    const fine = addJob('100000000002', 'ML Engineer', 'Beta', 'Build RAG agents.');
    const provider = fakeProvider((description) =>
      description.includes('BROKEN') ? new AiError('no valid evidence after 3 attempt(s): invalid JSON', false) : answer(description),
    );

    const summary = await analyzeJobs(db, testProfile, env, { provider, jobProfiles: testJobProfiles });
    expect(summary).toMatchObject({ attempted: 2, succeeded: 1, failed: 1, cacheMisses: 2 });
    expect(statusOf(broken)).toMatchObject({ status: 'ANALYSIS_FAILED', analysis_error: 'no valid evidence after 3 attempt(s): invalid JSON' });
    expect(statusOf(fine)).toMatchObject({ status: 'SHORTLISTED' });

    // A normal run leaves failed jobs alone; --force retries them.
    expect(await analyzeJobs(db, testProfile, env, { provider, jobProfiles: testJobProfiles })).toMatchObject({ attempted: 0 });
    const retried = fakeProvider(answer);
    await analyzeJobs(db, testProfile, env, { provider: retried, force: true, jobProfiles: testJobProfiles });
    expect(retried.calls).toEqual(['AI Engineer']);
    expect(statusOf(broken)).toMatchObject({ status: 'SHORTLISTED', analysis_error: null });
  });

  it('stops before any job when the model is not available, leaving jobs untouched', async () => {
    const id = addJob('100000000001', 'AI Engineer', 'Acme', 'Build RAG services in Python.');
    const provider = fakeProvider(answer);
    provider.ensureReady = async () => {
      throw new AiError('Ollama is not running at http://localhost:11434.\nStart Ollama and run the command again.', true);
    };

    await expect(analyzeJobs(db, testProfile, env, { provider, jobProfiles: testJobProfiles })).rejects.toThrow(/Ollama is not running/);
    expect(provider.calls).toEqual([]);
    expect(statusOf(id)).toMatchObject({ status: 'DISCOVERED', match_score: null });
  });

  it('stops mid-run on a fatal error without marking jobs failed', async () => {
    const id = addJob('100000000001', 'AI Engineer', 'Acme', 'Build RAG services in Python.');
    const provider = fakeProvider(() => new AiError('Ollama stopped responding', true));
    await expect(analyzeJobs(db, testProfile, env, { provider, jobProfiles: testJobProfiles })).rejects.toThrow(/stopped responding/);
    expect(statusOf(id)).toMatchObject({ status: 'DISCOVERED' });
  });

  it('puts previously filtered jobs back once a job profile covers them', () => {
    const id = addJob('100000000001', 'Data Engineer', 'Acme', 'Spark pipelines.');
    applyHardFilters(db, testJobProfiles);
    expect(statusOf(id)).toMatchObject({ status: 'SKIPPED' });

    const data = { id: 'data', name: 'Data Engineer', keywords: ['Data Engineer'], skills: [], exclude: [], ai: false };
    expect(applyHardFilters(db, [...testJobProfiles, data])).toEqual({ rejected: 0, kept: 1 });
    expect(statusOf(id)).toMatchObject({ status: 'DISCOVERED', filter_reason: null });
    expect(db.prepare('SELECT profiles FROM jobs WHERE id = ?').get(id)).toEqual({ profiles: '["data"]' });
  });
});

describe('background matching', () => {
  const run = (provider: ReturnType<typeof fakeProvider>, scope = { profiles: [], freshness: 'all' as const, experienceYears: 7, toleranceMonths: 6 }) =>
    matchInBackground(db, testProfile, env, { provider, jobProfiles: testJobProfiles, scope, signal: new AbortController().signal });

  it('scores relevant, eligible jobs once each, then unloads the model', async () => {
    const rag = addJob('100000000001', 'AI Engineer', 'Acme', 'Build RAG services in Python.');
    const unrelated = addJob('100000000002', 'Data Engineer', 'Beta', 'Spark pipelines.');
    const senior = addJob('100000000003', 'AI Engineer', 'Gamma', 'Lead RAG platform work.');
    db.prepare(`UPDATE jobs SET experience_min = 12 WHERE id = ?`).run(senior);
    applyHardFilters(db, testJobProfiles);

    const provider = fakeProvider(answer);
    expect(await run(provider)).toEqual({ matched: 1, failed: 0 });
    expect(provider.calls).toEqual(['AI Engineer']);
    expect(statusOf(rag)).toMatchObject({ status: 'SHORTLISTED', match_score: 100 });
    expect(statusOf(unrelated)).toMatchObject({ status: 'SKIPPED', match_score: null });
    expect(statusOf(senior)).toMatchObject({ status: 'DISCOVERED', match_score: null });
    expect(provider.releases).toBe(1);

    // Nothing is scored twice.
    const again = fakeProvider(answer);
    expect(await run(again)).toEqual({ matched: 0, failed: 0 });
    expect(again.calls).toEqual([]);
  });

  it('keeps the status of a job the run applied to while the model worked', async () => {
    const id = addJob('100000000001', 'AI Engineer', 'Acme', 'Build RAG services in Python.');
    applyHardFilters(db, testJobProfiles);
    const provider = fakeProvider((description) => {
      db.prepare(`UPDATE jobs SET status = 'APPLIED' WHERE id = ?`).run(id);
      return answer(description);
    });
    expect(await run(provider)).toEqual({ matched: 1, failed: 0 });
    expect(statusOf(id)).toMatchObject({ status: 'APPLIED', match_score: 100 });
  });

  it('stops quietly when the model is unavailable, leaving jobs as they were', async () => {
    const id = addJob('100000000001', 'AI Engineer', 'Acme', 'Build RAG services in Python.');
    applyHardFilters(db, testJobProfiles);
    const provider = fakeProvider(() => new AiError('Ollama is not running', true));
    expect(await run(provider)).toEqual({ matched: 0, failed: 0 });
    expect(statusOf(id)).toMatchObject({ status: 'DISCOVERED' });
  });

  it('does nothing once the run is stopped', async () => {
    addJob('100000000001', 'AI Engineer', 'Acme', 'Build RAG services in Python.');
    applyHardFilters(db, testJobProfiles);
    const provider = fakeProvider(answer);
    const stopped = new AbortController();
    stopped.abort();
    const result = await matchInBackground(db, testProfile, env, {
      provider,
      jobProfiles: testJobProfiles,
      scope: { profiles: [], freshness: 'all' },
      signal: stopped.signal,
    });
    expect(result).toEqual({ matched: 0, failed: 0 });
    expect(provider.calls).toEqual([]);
  });
});
