import type { Page } from 'playwright';
import { z } from 'zod';
import { htmlToText, parsePostedDate, type JobDetails } from '../jobs/normalization.ts';
import { DETAIL_SELECTORS } from './selectors.ts';
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

export async function readJobDetails(page: Page, url: string, { jsonLdWaitMs = 15_000 } = {}): Promise<JobDetails> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await assertUsable(page);

  await page
    .waitForFunction(
      (selector) => Array.from(document.querySelectorAll(selector)).some((s) => s.textContent?.includes('JobPosting')),
      DETAIL_SELECTORS.jsonLd,
      { timeout: jsonLdWaitMs },
    )
    .catch(() => {});
  const details = detailsFromJsonLd(await page.locator(DETAIL_SELECTORS.jsonLd).allTextContents());
  if (details) return details;

  const description = await page
    .getByRole('heading', { name: DETAIL_SELECTORS.descriptionHeading, exact: true })
    .locator('xpath=ancestor::section[1]')
    .innerText({ timeout: 5_000 })
    .catch(() => '');
  if (!description.trim()) throw new Error('No job description on the page; the posting may have expired');
  return { description: description.trim(), skills: [], employmentType: null, postedAt: null, workMode: null };
}
