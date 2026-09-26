import type { Page, Response } from 'playwright';
import { z } from 'zod';
import type { RawCard } from '../jobs/normalization.ts';
import { log } from '../logger.ts';
import { FRESHNESS_FILTER, NAUKRI_URLS, REMOTE_FILTER, SEARCH_API, SEARCH_SELECTORS } from './selectors.ts';
import { assertUsable } from './session.ts';

export interface SearchQuery {
  searchName: string;
  keyword: string;
  locations: string[];
  remote: boolean;
  // Naukri's freshness filter in days (1, 3, 7), or null for any age. No experience filter is ever sent.
  jobAge: number | null;
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Same shape as the URL Naukri's own search box produces: /react-developer-jobs-in-bangalore?k=...&l=...
export function buildSearchUrl({ keyword, locations, remote, jobAge }: SearchQuery): string {
  // Checked against the live site: a dot in the keyword ("React.js") makes Naukri rewrite the search
  // and silently drop its filters, including freshness and remote. "React js" keeps them.
  const params = new URLSearchParams({ k: keyword.replace(/\./g, ' ').replace(/\s+/g, ' ').trim() });
  let path = `${slug(keyword)}-jobs`;
  if (remote) {
    params.set(...REMOTE_FILTER);
  } else if (locations[0]) {
    path += `-in-${slug(locations[0])}`;
    params.set('l', locations.join(', ').toLowerCase());
  }
  // Checked against the live site: Naukri passes jobAge to its search API. It is approximate
  // ("1" still returns jobs up to about two days old), so fresh windows are also applied locally.
  if (jobAge) params.set(FRESHNESS_FILTER, String(jobAge));
  return `${NAUKRI_URLS.base}/${path}?${params}`;
}

const apiJobSchema = z.object({
  jobId: z.coerce.string(),
  title: z.string(),
  companyName: z.string(),
  jdURL: z.string(),
  placeholders: z.array(z.object({ type: z.string(), label: z.string() })).optional(),
  createdDate: z.number().optional(),
  footerPlaceholderLabel: z.string().optional(),
  tagsAndSkills: z.string().optional(),
  companyApplyJob: z.boolean().optional(),
});

export function cardsFromSearchApi(body: unknown): RawCard[] {
  const parsed = z.object({ jobDetails: z.array(z.unknown()).optional() }).safeParse(body);
  if (!parsed.success) return [];
  return (parsed.data.jobDetails ?? []).flatMap((item) => {
    const job = apiJobSchema.safeParse(item);
    if (!job.success) return [];
    const label = (type: string) => job.data.placeholders?.find((p) => p.type === type)?.label;
    return [
      {
        externalId: job.data.jobId,
        url: new URL(job.data.jdURL, NAUKRI_URLS.base).href,
        title: job.data.title,
        company: job.data.companyName,
        experience: label('experience'),
        salary: label('salary'),
        location: label('location'),
        posted: job.data.createdDate ?? job.data.footerPlaceholderLabel,
        skills: job.data.tagsAndSkills?.split(',') ?? [],
        externalApply: job.data.companyApplyJob,
      },
    ];
  });
}

async function cardsFromDom(page: Page): Promise<RawCard[]> {
  await page.locator(SEARCH_SELECTORS.card).first().waitFor({ timeout: 5_000 }).catch(() => {});
  return page.locator(SEARCH_SELECTORS.card).evaluateAll(
    (cards, s) =>
      cards.map((card) => {
        const text = (selector: string) => card.querySelector(selector)?.textContent?.trim() || undefined;
        const link = card.querySelector<HTMLAnchorElement>(s.title);
        return {
          externalId: card.getAttribute('data-job-id') || undefined,
          url: link?.href,
          title: link?.textContent?.trim(),
          company: text(s.company),
          experience: text(s.experience),
          salary: text(s.salary),
          location: text(s.location),
          posted: text(s.posted),
          skills: Array.from(card.querySelectorAll(s.tags), (tag) => tag.textContent?.trim() ?? ''),
        };
      }),
    SEARCH_SELECTORS,
  );
}

function isResultsResponse(response: Response, pageNo: number): boolean {
  return SEARCH_API.test(response.url()) && new URL(response.url()).searchParams.get('pageNo') === String(pageNo);
}

// The filters a search asked for that Naukri's own results request left out.
export function droppedFilters(searchUrl: string, apiUrl: string): string[] {
  const wanted = new URL(searchUrl).searchParams;
  const sent = new URL(apiUrl).searchParams;
  return [FRESHNESS_FILTER, REMOTE_FILTER[0]].filter((name) => wanted.has(name) && sent.get(name) !== wanted.get(name));
}

async function readResults(page: Page, url: string, pageNo: number, navigate: () => Promise<unknown>): Promise<RawCard[]> {
  const response = page.waitForResponse((res) => isResultsResponse(res, pageNo), { timeout: 20_000 }).catch(() => null);
  await navigate();
  await assertUsable(page);

  const res = await response;
  const dropped = res ? droppedFilters(url, res.url()) : [];
  if (dropped.length) {
    // Unfiltered results would store old or non-remote jobs as if they matched; skip this search.
    log.warn(`Naukri dropped the ${dropped.join(' and ')} filter for this search; its results are skipped`);
    return [];
  }
  const body = await res?.json().catch(() => null);
  const apiCards = body ? cardsFromSearchApi(body) : [];
  if (apiCards.length) return apiCards;

  // Either the response changed shape or there are no results; the rendered cards settle which.
  const domCards = await cardsFromDom(page);
  if (domCards.length) log.debug('Search response unusable; read job cards from the page instead');
  return domCards;
}

// Yields one page of results at a time. Stopping early (break) skips the remaining page loads.
export async function* searchResultPages(page: Page, url: string, maxPages: number): AsyncGenerator<RawCard[]> {
  const first = await readResults(page, url, 1, () => page.goto(url, { waitUntil: 'domcontentloaded' }));
  yield first;
  if (!first.length) return;
  for (let pageNo = 2; pageNo <= maxPages; pageNo++) {
    const next = page.locator(SEARCH_SELECTORS.nextPage).first();
    const visible = await next.waitFor({ state: 'visible', timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    if (!visible || (await next.getAttribute('disabled')) !== null) return;
    // Clicking keeps every filter; loading the "-2" URL directly drops the query parameters.
    yield await readResults(page, url, pageNo, () => next.click());
  }
}
