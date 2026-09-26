import type { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright';
import { politePause, saveDebugScreenshot } from '../browser/browser.ts';
import { readJobDetails } from '../browser/job-details.ts';
import { buildSearchUrl, searchResultPages, type SearchQuery } from '../browser/search.ts';
import { RunStopped } from '../browser/session.ts';
import type { Env, JobProfile, Profile } from '../config.ts';
import { insertJob, jobsNeedingDetails, recordDetailFailure, saveJobDetails } from '../db/jobs.ts';
import type { JobScope } from '../domain.ts';
import { log } from '../logger.ts';
import { applyHardFilters } from './matching.ts';
import { normalizeCard } from './normalization.ts';

const isRemote = (location: string) => /^(remote|work from home|wfh)$/i.test(location.trim());

// Naukri's freshness filter offers these day counts; the exact window is applied locally afterwards.
const NAUKRI_DAYS = [1, 3, 7, 15, 30];
const DAYS: Partial<Record<JobScope['freshness'], number>> = { today: 1, '24h': 1, '2d': 2, '3d': 3, '7d': 7 };

// The smallest Naukri freshness filter that covers the window, or null for no filter.
export function naukriJobAge(scope: Pick<JobScope, 'freshness' | 'from'>, now = new Date()): number | null {
  let days = DAYS[scope.freshness];
  if (scope.freshness === 'custom' && scope.from) {
    const [y, m, d] = scope.from.split('-').map(Number);
    days = Math.max(1, Math.ceil((now.getTime() - new Date(y!, m! - 1, d!).getTime()) / 86_400_000));
  }
  return days === undefined ? null : (NAUKRI_DAYS.find((n) => n >= days) ?? null);
}

// One query per profile keyword for your cities, plus one with Naukri's Remote filter when "Remote"
// is one of your locations. --keyword searches just that keyword instead.
export function planQueries(
  jobProfiles: JobProfile[],
  profile: Pick<Profile, 'preferredLocations'>,
  {
    keywords = [],
    locations = [],
    freshness = 'all',
    from = null,
  }: { keywords?: string[]; locations?: string[] } & Partial<Pick<JobScope, 'freshness' | 'from'>> = {},
): SearchQuery[] {
  const groups = keywords.length ? [{ id: 'command line', keywords }] : jobProfiles;
  const wanted = locations.length ? locations : profile.preferredLocations;
  const cities = wanted.filter((l) => !isRemote(l));
  const jobAge = naukriJobAge({ freshness, from });
  const seen = new Set<string>();
  return groups
    .flatMap((group) => {
      const base = { searchName: group.id, jobAge };
      return group.keywords.flatMap((keyword) => [
        ...(cities.length ? [{ ...base, keyword, locations: cities, remote: false }] : []),
        ...(wanted.some(isRemote) ? [{ ...base, keyword, locations: [], remote: true }] : []),
      ]);
    })
    .filter((query) => {
      const key = `${query.keyword.toLowerCase()}|${query.locations.join(',').toLowerCase()}|${query.remote}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function describeQuery(query: SearchQuery): string {
  return `${query.keyword} (${query.remote ? 'Remote' : query.locations.join(', ')})`;
}

// A closed window fails every later step the same way, so it ends the run like a block does.
function stopIfClosed(page: Page, err: unknown): void {
  if (err instanceof RunStopped) throw err;
  if (page.isClosed()) throw new RunStopped('The browser window was closed during the run.', 'BROWSER_CLOSED');
}

export async function discoverJobs(
  page: Page,
  db: DatabaseSync,
  queries: SearchQuery[],
  env: Env,
  {
    signal,
    whilePaused,
    onPage,
  }: { signal?: AbortSignal; whilePaused?: () => Promise<void>; onPage?: (progress: { found: number; added: number }) => void } = {},
): Promise<{ seen: number; added: number; found: number }> {
  let seen = 0;
  let added = 0;
  // The same job often turns up under several keywords.
  const found = new Set<string>();

  const cap = env.MAX_JOBS_PER_RUN ?? Infinity;
  for (const [index, query] of queries.entries()) {
    await whilePaused?.();
    if (signal?.aborted) break;
    if (added >= cap) {
      log.info(`Reached MAX_JOBS_PER_RUN (${cap}); skipping ${queries.length - index} remaining search(es)`);
      break;
    }
    if (index > 0) await politePause(page, env);
    log.info(`Searching: ${describeQuery(query)}`);

    try {
      let pageNo = 0;
      for await (const cards of searchResultPages(page, buildSearchUrl(query), env.SEARCH_MAX_PAGES)) {
        pageNo++;
        seen += cards.length;
        let fresh = 0;
        let known = 0;
        for (const raw of cards) {
          if (added >= cap) break;
          const job = normalizeCard(raw);
          if (!job) continue;
          found.add(job.externalId ?? job.url);
          if (insertJob(db, job, query.searchName)) {
            added++;
            fresh++;
          } else {
            known++;
          }
        }
        log.info(`  Page ${pageNo}: ${cards.length} jobs, ${fresh} new${known ? `, ${known} already stored` : ''}`);
        onPage?.({ found: found.size, added });
        // A page of nothing new means this search is already covered; don't dig deeper.
        if (fresh === 0 || added >= cap || signal?.aborted) break;
        await politePause(page, env);
      }
    } catch (err) {
      stopIfClosed(page, err);
      log.warn(`Search failed: ${describeQuery(query)}`, err);
      if (env.DEBUG_SCREENSHOTS) await saveDebugScreenshot(page, 'search');
    }
  }
  return { seen, added, found: found.size };
}

export async function fetchMissingDetails(
  page: Page,
  db: DatabaseSync,
  env: Env,
  { scope, signal }: { scope?: JobScope; signal?: AbortSignal } = {},
): Promise<{ fetched: number; failed: number }> {
  const jobs = jobsNeedingDetails(db, { scope });
  let fetched = 0;
  let failed = 0;
  if (!jobs.length) return { fetched, failed };

  const minutes = Math.ceil((jobs.length * ((env.DELAY_MIN_MS + env.DELAY_MAX_MS) / 2 + 1_500)) / 60_000);
  log.info(`Reading ${jobs.length} job description(s), about ${minutes} min. Stopping early is safe; the rest wait for the next run.`);
  for (const [index, job] of jobs.entries()) {
    if (signal?.aborted) break;
    await politePause(page, env);
    try {
      saveJobDetails(db, job.id, await readJobDetails(page, job.url));
      fetched++;
      log.debug(`Read ${job.title} at ${job.company}`);
    } catch (err) {
      stopIfClosed(page, err);
      recordDetailFailure(db, job.id);
      failed++;
      log.warn(`Could not read ${job.title} at ${job.company}`, err);
      if (env.DEBUG_SCREENSHOTS) await saveDebugScreenshot(page, 'job-details');
    }
    if ((index + 1) % 10 === 0) log.info(`  ${index + 1}/${jobs.length} read`);
  }
  return { fetched, failed };
}

// Search Naukri, sort the results into job profiles and drop obvious mismatches from the listing data,
// then read the remaining descriptions (only those in `scope`, freshest first). Counts land in `stats`
// as they happen, so a stopped run still reports what it did.
export async function searchJobs(
  page: Page,
  db: DatabaseSync,
  env: Env,
  profile: Profile,
  jobProfiles: JobProfile[],
  queries: SearchQuery[],
  { stats, scope, signal }: { stats: Record<string, number>; scope?: JobScope; signal?: AbortSignal },
): Promise<void> {
  stats.searches = queries.length;
  log.info(`${queries.length} search(es) planned, up to ${env.SEARCH_MAX_PAGES} result page(s) each`);
  for (const query of queries) log.debug(`  ${describeQuery(query)}`);

  const { seen, added } = await discoverJobs(page, db, queries, env, { signal });
  Object.assign(stats, { seen, added });
  log.info(`Found ${seen} jobs, ${added} new`);

  const { rejected } = applyHardFilters(db, jobProfiles);
  stats.filtered = rejected;
  if (rejected) log.info(`Filtered out ${rejected} job(s) on location or title before reading descriptions`);
  if (signal?.aborted) return;

  const { fetched, failed } = await fetchMissingDetails(page, db, env, { scope, signal });
  Object.assign(stats, { detailsRead: fetched, detailsFailed: failed });
  if (fetched || failed) log.info(`Descriptions read: ${fetched}${failed ? `, failed: ${failed}` : ''}`);
}
