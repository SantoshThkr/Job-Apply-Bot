import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { launchBrowser } from '../src/browser/browser.ts';
import { detailsFromJsonLd, readJobDetails } from '../src/browser/job-details.ts';
import { buildSearchUrl, cardsFromSearchApi, searchResultPages } from '../src/browser/search.ts';
import { RunStopped } from '../src/browser/session.ts';
import type { Profile } from '../src/config.ts';
import { planQueries } from '../src/jobs/discovery.ts';

// Synthetic data shaped like Naukri's responses; no real postings.
const apiJob = (id: string, title: string, extra: object = {}) => ({
  jobId: id,
  title,
  companyName: 'Acme',
  jdURL: `/job-listings-${title.toLowerCase().replace(/ /g, '-')}-acme-bengaluru-5-to-10-years-${id}`,
  placeholders: [
    { type: 'experience', label: '5-10 Yrs' },
    { type: 'salary', label: 'Not disclosed' },
    { type: 'location', label: 'Hybrid - Bengaluru' },
  ],
  createdDate: new Date(2026, 8, 20, 12).getTime(),
  tagsAndSkills: 'React,TypeScript',
  companyApplyJob: false,
  ...extra,
});

const profile: Profile = {
  name: 'Test Candidate',
  experienceYears: 7,
  targetRoles: ['AI Engineer'],
  primarySkills: ['React'],
  secondarySkills: [],
  preferredLocations: ['Remote', 'Bangalore'],
  minimumExperience: 6,
  maximumExperience: 12,
  skillAliases: {},
};

describe('planQueries', () => {
  it('splits Remote into its own filtered search and fills in profile locations', () => {
    const queries = planQueries(
      [
        { name: 'AI', keywords: ['AI Engineer'], locations: ['Pune', 'Remote'] },
        { name: 'Frontend', keywords: ['React Developer'] },
      ],
      profile,
    );
    expect(queries.map((q) => [q.searchName, q.keyword, q.locations, q.remote])).toEqual([
      ['AI', 'AI Engineer', ['Pune'], false],
      ['AI', 'AI Engineer', [], true],
      ['Frontend', 'React Developer', ['Bangalore'], false],
      ['Frontend', 'React Developer', [], true],
    ]);
    expect(queries.every((q) => q.experience === 7)).toBe(true);
  });

  it('applies command-line overrides and drops repeated searches', () => {
    expect(planQueries([], profile, { keyword: 'LLM Engineer', location: 'Remote' })).toEqual([
      { searchName: 'command line', keyword: 'LLM Engineer', locations: [], remote: true, experience: 7 },
    ]);
    const repeated = planQueries(
      [
        { name: 'A', keywords: ['AI Engineer'], locations: ['Pune'] },
        { name: 'B', keywords: ['ai engineer'], locations: ['pune'] },
      ],
      profile,
    );
    expect(repeated).toHaveLength(1);
  });
});

describe('buildSearchUrl', () => {
  it('builds the URL Naukri’s search box would', () => {
    const base = { searchName: 'x', keyword: 'React Developer', experience: 7.5 };
    expect(buildSearchUrl({ ...base, locations: ['Bangalore', 'Hyderabad'], remote: false })).toBe(
      'https://www.naukri.com/react-developer-jobs-in-bangalore?k=React+Developer&l=bangalore%2C+hyderabad&experience=7',
    );
    expect(buildSearchUrl({ ...base, locations: [], remote: true })).toBe(
      'https://www.naukri.com/react-developer-jobs?k=React+Developer&wfhType=2&experience=7',
    );
  });
});

describe('cardsFromSearchApi', () => {
  it('maps the search response and skips malformed entries', () => {
    const cards = cardsFromSearchApi({
      jobDetails: [apiJob('111122223333', 'AI Engineer', { companyApplyJob: true }), { jobId: 1 }],
    });
    expect(cards).toEqual([
      {
        externalId: '111122223333',
        url: 'https://www.naukri.com/job-listings-ai-engineer-acme-bengaluru-5-to-10-years-111122223333',
        title: 'AI Engineer',
        company: 'Acme',
        experience: '5-10 Yrs',
        salary: 'Not disclosed',
        location: 'Hybrid - Bengaluru',
        posted: new Date(2026, 8, 20, 12).getTime(),
        skills: ['React', 'TypeScript'],
        externalApply: true,
      },
    ]);
  });

  it('returns nothing for empty or unexpected responses', () => {
    expect(cardsFromSearchApi({ noOfJobs: 0 })).toEqual([]);
    expect(cardsFromSearchApi('not json')).toEqual([]);
  });
});

describe('detailsFromJsonLd', () => {
  it('reads the JobPosting block and ignores the rest', () => {
    const details = detailsFromJsonLd([
      '{ broken',
      JSON.stringify({ '@type': 'BreadcrumbList', itemListElement: [] }),
      JSON.stringify({
        '@type': 'JobPosting',
        description: '<p>Build <b>RAG</b> pipelines</p>',
        datePosted: '2026-08-26',
        employmentType: 'Full Time, Permanent',
        skills: ['Python', 'LLM'],
        jobLocationType: 'TELECOMMUTE',
      }),
    ]);
    expect(details).toEqual({
      description: 'Build RAG pipelines',
      skills: ['Python', 'LLM'],
      employmentType: 'Full Time, Permanent',
      postedAt: '2026-08-26',
      workMode: 'Remote',
    });
  });
});

describe('Naukri pages (mocked)', () => {
  let context: BrowserContext;
  let page: Page;
  const profileDir = mkdtempSync(join(tmpdir(), 'naukri-bot-search-'));
  const channel = process.env.BROWSER_CHANNEL === 'chromium' ? 'chromium' : 'chrome';

  beforeAll(async () => {
    context = await launchBrowser({ headless: true, channel, profileDir });
  });
  afterAll(async () => {
    await context.close();
    rmSync(profileDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    page = await context.newPage();
  });
  afterEach(async () => {
    await page.close();
    await context.unrouteAll();
  });

  // Every naukri.com request is answered locally; nothing reaches the real site.
  async function serve(handler: (path: string, params: URLSearchParams) => { status?: number; body: unknown } | undefined) {
    await context.route('https://www.naukri.com/**', (route) => {
      const url = new URL(route.request().url());
      const res = handler(url.pathname, url.searchParams);
      const isJson = res && typeof res.body !== 'string';
      return route.fulfill({
        status: res?.status ?? (res ? 200 : 404),
        contentType: isJson ? 'application/json' : 'text/html',
        body: isJson ? JSON.stringify(res.body) : ((res?.body as string) ?? ''),
      });
    });
  }

  // Behaves like the real results page: fetches jobs client-side, paginates via pushState.
  const resultsPage = (inlineJobs?: object[]) => `
    <div id="results"></div>
    <div class="styles_pagination__abc"><a id="next" href="/x-2"><span>Next</span></a></div>
    <script>
      let pageNo = 1;
      const render = (jobs) => document.getElementById('results').innerHTML = jobs.map((j) =>
        '<div class="srp-jobtuple-wrapper" data-job-id="' + j.jobId + '"><a class="title" href="' + j.jdURL + '">' + j.title +
        '</a><a class="comp-name">' + j.companyName + '</a><span class="expwdth">5-10 Yrs</span>' +
        '<span class="locWdth">Bengaluru</span><span class="job-post-day">2 Days Ago</span></div>').join('');
      async function load() {
        const body = await fetch('/jobapi/v3/search?noOfResults=20&pageNo=' + pageNo).then((r) => r.json());
        render(${inlineJobs ? JSON.stringify(inlineJobs) : 'body.jobDetails || []'});
        if (pageNo >= 2) document.getElementById('next').setAttribute('disabled', '');
      }
      document.getElementById('next').addEventListener('click', (e) => {
        e.preventDefault(); pageNo++; history.pushState(null, '', location.pathname + '-2' + location.search); load();
      });
      load();
    </script>`;

  const collect = async (url: string, maxPages = 3) => {
    const pages = [];
    for await (const cards of searchResultPages(page, url, maxPages)) pages.push(cards);
    return pages;
  };

  it('reads each results page from the search response and follows Next', async () => {
    await serve((path, params) => {
      if (path === '/react-developer-jobs-in-bangalore') return { body: resultsPage() };
      if (path === '/jobapi/v3/search') {
        const jobs = params.get('pageNo') === '1' ? [apiJob('100000000001', 'AI Engineer'), apiJob('100000000002', 'ML Engineer')] : [apiJob('100000000003', 'LLM Engineer')];
        return { body: { noOfJobs: 3, jobDetails: jobs } };
      }
    });
    const pages = await collect('https://www.naukri.com/react-developer-jobs-in-bangalore?k=react');
    expect(pages.map((cards) => cards.map((c) => c.title))).toEqual([['AI Engineer', 'ML Engineer'], ['LLM Engineer']]);
    expect(pages[0]![0]).toMatchObject({ externalId: '100000000001', location: 'Hybrid - Bengaluru', externalApply: false });
  });

  it('falls back to the rendered cards when the response shape changes', async () => {
    await serve((path) => {
      if (path === '/react-developer-jobs-in-bangalore') return { body: resultsPage([apiJob('100000000009', 'Frontend Engineer')]) };
      if (path === '/jobapi/v3/search') return { body: { results: [] } };
    });
    const [cards] = await collect('https://www.naukri.com/react-developer-jobs-in-bangalore?k=react', 1);
    expect(cards).toEqual([
      {
        externalId: '100000000009',
        url: 'https://www.naukri.com/job-listings-frontend-engineer-acme-bengaluru-5-to-10-years-100000000009',
        title: 'Frontend Engineer',
        company: 'Acme',
        experience: '5-10 Yrs',
        salary: undefined,
        location: 'Bengaluru',
        posted: '2 Days Ago',
        skills: [],
      },
    ]);
  });

  it('stops the run when Naukri blocks the browser', async () => {
    await serve(() => ({ status: 403, body: '<title>Access Denied</title>Access Denied' }));
    await expect(collect('https://www.naukri.com/react-developer-jobs?k=react')).rejects.toThrow(RunStopped);
  });

  it('reads job details from JSON-LD injected after load', async () => {
    const posting = { '@type': 'JobPosting', description: '<p>Ship AI features</p>', datePosted: '2026-09-01', skills: ['React'] };
    await serve((path) => {
      if (path.startsWith('/job-listings-')) {
        return {
          body: `<h1>AI Engineer</h1><script>
            setTimeout(() => {
              const s = document.createElement('script');
              s.type = 'application/ld+json';
              s.textContent = ${JSON.stringify(JSON.stringify(posting))};
              document.head.append(s);
            }, 200);
          </script>`,
        };
      }
    });
    const details = await readJobDetails(page, 'https://www.naukri.com/job-listings-ai-engineer-100000000001');
    expect(details).toMatchObject({ description: 'Ship AI features', postedAt: '2026-09-01', skills: ['React'] });
  });

  it('falls back to the description section when there is no JSON-LD', async () => {
    await serve((path) => {
      if (path.startsWith('/job-listings-')) {
        return { body: '<main><section><div><h2>Job description</h2></div><p>Build agents with LLMs.</p></section></main>' };
      }
    });
    const details = await readJobDetails(page, 'https://www.naukri.com/job-listings-ai-engineer-100000000001', { jsonLdWaitMs: 300 });
    expect(details.description).toBe('Job description\n\nBuild agents with LLMs.');
  });
});
