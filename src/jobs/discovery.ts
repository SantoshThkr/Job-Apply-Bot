import type { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright';
import { politePause, saveDebugScreenshot } from '../browser/browser.ts';
import { readJobDetails } from '../browser/job-details.ts';
import { buildSearchUrl, searchResultPages, type SearchQuery } from '../browser/search.ts';
import { RunStopped } from '../browser/session.ts';
import type { Env, Profile, Search } from '../config.ts';
import { insertJob, jobsNeedingDetails, recordDetailFailure, saveJobDetails } from '../db/jobs.ts';
import { log } from '../logger.ts';
import { normalizeCard } from './normalization.ts';

// Later pages are mostly weaker matches, and every page is another request.
const MAX_PAGES_PER_SEARCH = 3;

const isRemote = (location: string) => /^(remote|work from home|wfh)$/i.test(location.trim());

// One query per keyword for the listed cities, plus one with Naukri's Remote filter when "Remote" is listed.
export function planQueries(
  searches: Search[],
  profile: Profile,
  override: { keyword?: string; location?: string } = {},
): SearchQuery[] {
  const groups: Search[] = override.keyword ? [{ name: 'command line', keywords: [override.keyword] }] : searches;
  const seen = new Set<string>();
  return groups
    .flatMap((group) => {
      const wanted = override.location ? [override.location] : (group.locations ?? profile.preferredLocations);
      const cities = wanted.filter((l) => !isRemote(l));
      const base = { searchName: group.name, experience: profile.experienceYears };
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

export async function discoverJobs(
  page: Page,
  db: DatabaseSync,
  queries: SearchQuery[],
  env: Env,
): Promise<{ seen: number; added: number }> {
  let seen = 0;
  let added = 0;

  for (const [index, query] of queries.entries()) {
    if (added >= env.MAX_JOBS_PER_RUN) {
      log.info(`Reached MAX_JOBS_PER_RUN (${env.MAX_JOBS_PER_RUN}); skipping ${queries.length - index} remaining search(es)`);
      break;
    }
    if (index > 0) await politePause(page, env);
    log.info(`Searching: ${describeQuery(query)}`);

    try {
      let pageNo = 0;
      for await (const cards of searchResultPages(page, buildSearchUrl(query), MAX_PAGES_PER_SEARCH)) {
        pageNo++;
        seen += cards.length;
        let fresh = 0;
        let known = 0;
        for (const raw of cards) {
          if (added >= env.MAX_JOBS_PER_RUN) break;
          const job = normalizeCard(raw);
          if (!job) continue;
          if (insertJob(db, job, query.searchName)) {
            added++;
            fresh++;
          } else {
            known++;
          }
        }
        log.info(`  Page ${pageNo}: ${cards.length} jobs, ${fresh} new${known ? `, ${known} already stored` : ''}`);
        // A page of nothing new means this search is already covered; don't dig deeper.
        if (fresh === 0 || added >= env.MAX_JOBS_PER_RUN) break;
        await politePause(page, env);
      }
    } catch (err) {
      if (err instanceof RunStopped) throw err;
      log.warn(`Search failed: ${describeQuery(query)}`, err);
      await saveDebugScreenshot(page, 'search');
    }
  }
  return { seen, added };
}

export async function fetchMissingDetails(
  page: Page,
  db: DatabaseSync,
  env: Env,
): Promise<{ fetched: number; failed: number }> {
  const jobs = jobsNeedingDetails(db, env.MAX_JOBS_PER_RUN);
  let fetched = 0;
  let failed = 0;
  if (!jobs.length) return { fetched, failed };

  const minutes = Math.ceil((jobs.length * ((env.DELAY_MIN_MS + env.DELAY_MAX_MS) / 2 + 1_500)) / 60_000);
  log.info(`Reading ${jobs.length} job description(s), about ${minutes} min. Stopping early is safe; the rest wait for the next run.`);
  for (const [index, job] of jobs.entries()) {
    await politePause(page, env);
    try {
      saveJobDetails(db, job.id, await readJobDetails(page, job.url));
      fetched++;
      log.debug(`Read ${job.title} at ${job.company}`);
    } catch (err) {
      if (err instanceof RunStopped) throw err;
      recordDetailFailure(db, job.id);
      failed++;
      log.warn(`Could not read ${job.title} at ${job.company}`, err);
      await saveDebugScreenshot(page, 'job-details');
    }
    if ((index + 1) % 10 === 0) log.info(`  ${index + 1}/${jobs.length} read`);
  }
  return { fetched, failed };
}
