import type { Page, Response } from 'playwright';
import { z } from 'zod';
import { htmlToText, parsePostedDate, type JobDetails } from '../jobs/normalization.ts';
import { DETAIL_SELECTORS, JOB_API } from './selectors.ts';
import { assertUsable } from './session.ts';

const stringOrList = z.union([z.string(), z.array(z.string())]);

const jobPostingSchema = z.object({
  '@type': z.literal('JobPosting'),
  description: z.string().trim().min(1),
  datePosted: z.string().optional(),
  employmentType: stringOrList.optional(),
  jobLocationType: z.string().optional(),
  skills: stringOrList.optional(),
});

const asList = (value?: string | string[]) =>
  (Array.isArray(value) ? value : (value?.split(',') ?? [])).map((s) => s.trim()).filter(Boolean);

export function detailsFromJsonLd(blocks: string[]): JobDetails | null {
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    for (const item of [parsed].flat()) {
      const posting = jobPostingSchema.safeParse(item);
      if (!posting.success) continue;
      return {
        description: htmlToText(posting.data.description),
        skills: asList(posting.data.skills),
        employmentType: asList(posting.data.employmentType).join(', ') || null,
        postedAt: parsePostedDate(posting.data.datePosted),
        // schema.org only marks remote postings (TELECOMMUTE); hybrid/office come from the search card.
        workMode: posting.data.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null,
      };
    }
  }
  return null;
}

const jobApiSchema = z.object({ jobDetails: z.object({ applyRedirectUrl: z.string().optional() }) });

// The description, plus the company's own application URL when Naukri sends applicants there.
export async function readJobDetails(
  page: Page,
  url: string,
  { jsonLdWaitMs = 15_000 } = {},
): Promise<JobDetails & { externalUrl: string | null }> {
  let api: Promise<unknown> = Promise.resolve(null);
  const onResponse = (res: Response) => {
    if (JOB_API.test(res.url())) api = res.json().catch(() => null);
  };
  page.on('response', onResponse);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await assertUsable(page);
    return await readPage(page, jsonLdWaitMs, () => api);
  } finally {
    page.off('response', onResponse);
  }
}

async function readPage(page: Page, jsonLdWaitMs: number, api: () => Promise<unknown>): Promise<JobDetails & { externalUrl: string | null }> {
  await page
    .waitForFunction(
      (selector) => Array.from(document.querySelectorAll(selector)).some((s) => s.textContent?.includes('JobPosting')),
      DETAIL_SELECTORS.jsonLd,
      { timeout: jsonLdWaitMs },
    )
    .catch(() => {});
  const parsedApi = jobApiSchema.safeParse(await api());
  const externalUrl = (parsedApi.success && parsedApi.data.jobDetails.applyRedirectUrl) || null;
  const details = detailsFromJsonLd(await page.locator(DETAIL_SELECTORS.jsonLd).allTextContents());
  if (details) return { ...details, externalUrl };

  const description = await page
    .getByRole('heading', { name: DETAIL_SELECTORS.descriptionHeading, exact: true })
    .locator('xpath=ancestor::section[1]')
    .innerText({ timeout: 5_000 })
    .catch(() => '');
  if (!description.trim()) throw new Error('No job description on the page; the posting may have expired');
  return { description: description.trim(), skills: [], employmentType: null, postedAt: null, workMode: null, externalUrl };
}
