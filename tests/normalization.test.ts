import { describe, expect, it } from 'vitest';
import {
  canonicalJobUrl,
  dedupeKey,
  htmlToText,
  jobIdFromUrl,
  normalizeCard,
  parseExperience,
  parsePostedDate,
  parseSalaryLakhs,
  splitLocations,
  workModeFromLocation,
} from '../src/jobs/normalization.ts';

describe('parseExperience', () => {
  it.each([
    ['5-10 Yrs', { min: 5, max: 10 }],
    ['0-2 Yrs', { min: 0, max: 2 }],
    ['5 to 10 years', { min: 5, max: 10 }],
    ['10+ Yrs', { min: 10, max: null }],
    ['7 Yrs', { min: 7, max: 7 }],
    ['Fresher', { min: 0, max: 0 }],
  ])('%s', (label, expected) => {
    expect(parseExperience(label)).toEqual(expected);
  });

  it('returns null when there is nothing to parse', () => {
    expect(parseExperience(null)).toBeNull();
    expect(parseExperience('Not mentioned')).toBeNull();
  });
});

describe('parseSalaryLakhs', () => {
  it.each([
    ['15-22.5 Lacs PA', { min: 15, max: 22.5 }],
    ['0-22 Lacs PA', { min: 0, max: 22 }],
    ['12 Lacs PA', { min: 12, max: 12 }],
    ['1-1.5 Cr PA', { min: 100, max: 150 }],
    ['50,000-1.5 Lacs PA', { min: 0.5, max: 1.5 }],
  ])('%s', (label, expected) => {
    expect(parseSalaryLakhs(label)).toEqual(expected);
  });

  it('returns null for undisclosed salaries', () => {
    expect(parseSalaryLakhs('Not disclosed')).toBeNull();
    expect(parseSalaryLakhs(null)).toBeNull();
  });
});

describe('parsePostedDate', () => {
  const now = new Date(2026, 8, 25, 12);

  it('reads epoch milliseconds, ISO dates and relative labels', () => {
    expect(parsePostedDate(new Date(2026, 7, 26, 12).getTime())).toBe(new Date(2026, 7, 26, 12).toISOString());
    expect(parsePostedDate('2026-08-26')).toBe('2026-08-26');
    expect(parsePostedDate('Just Now', now)).toBe(now.toISOString());
    expect(parsePostedDate('3 hours ago', now)).toBe(new Date(now.getTime() - 3 * 3_600_000).toISOString());
    expect(parsePostedDate('Today', now)).toBe('2026-09-25');
    expect(parsePostedDate('1 Day Ago', now)).toBe('2026-09-24');
    expect(parsePostedDate('30+ Days Ago', now)).toBe('2026-08-26');
    expect(parsePostedDate('3+ weeks ago', now)).toBe('2026-09-04');
  });

  it('returns null for unknown labels', () => {
    expect(parsePostedDate('recently', now)).toBeNull();
    expect(parsePostedDate(undefined, now)).toBeNull();
  });
});

describe('locations', () => {
  it('derives the work mode from the Naukri label', () => {
    expect(workModeFromLocation('Remote')).toBe('Remote');
    expect(workModeFromLocation('Hybrid - Bengaluru')).toBe('Hybrid');
    expect(workModeFromLocation('Pune, Mumbai')).toBe('Office');
    expect(workModeFromLocation(null)).toBeNull();
  });

  it('splits labels and maps city aliases', () => {
    expect(splitLocations('Hybrid - Hyderabad, Chennai, Bengaluru')).toEqual(['Hyderabad', 'Chennai', 'Bangalore']);
    expect(splitLocations('Gurgaon, Delhi / NCR, Mumbai (All Areas)')).toEqual(['Gurugram', 'Delhi NCR', 'Mumbai']);
    expect(splitLocations('Noida(Sector 63)')).toEqual(['Noida']);
    expect(splitLocations('Remote')).toEqual(['Remote']);
  });
});

describe('job identity', () => {
  const url =
    'https://www.naukri.com/job-listings-react-developer-acme-bengaluru-5-to-10-years-190826037194?src=jobsearchDesk&sid=123';

  it('canonicalizes URLs and extracts the job ID', () => {
    expect(canonicalJobUrl(url)).toBe('https://www.naukri.com/job-listings-react-developer-acme-bengaluru-5-to-10-years-190826037194');
    expect(canonicalJobUrl('/job-listings-x-190826037194/')).toBe('https://www.naukri.com/job-listings-x-190826037194');
    expect(jobIdFromUrl(url)).toBe('190826037194');
    expect(jobIdFromUrl('https://www.naukri.com/react-developer-jobs')).toBeNull();
  });

  it('gives the same dedupe key to cosmetic variants of one posting', () => {
    const a = dedupeKey({ company: 'Acme Technologies Pvt. Ltd.', title: 'Senior React Developer', location: 'Bengaluru, Pune' });
    const b = dedupeKey({ company: 'ACME Technologies Private Limited', title: 'Senior React  Developer', location: 'Hybrid - Pune, Bangalore' });
    expect(a).toBe(b);
    expect(dedupeKey({ company: 'Acme Technologies', title: 'Senior React Developer', location: 'Chennai' })).not.toBe(a);
  });
});

describe('normalizeCard', () => {
  it('fills parsed fields and falls back to the ID in the URL', () => {
    const job = normalizeCard(
      {
        url: 'https://www.naukri.com/job-listings-ai-engineer-acme-remote-6-to-9-years-111122223333?src=x',
        title: '  AI Engineer ',
        company: 'Acme',
        location: 'Remote',
        experience: '6-9 Yrs',
        salary: '30-40 Lacs PA',
        posted: '2 Days Ago',
        skills: ['Python', ' LLM', 'Python', ''],
      },
      new Date(2026, 8, 25, 12),
    );
    expect(job).toMatchObject({
      externalId: '111122223333',
      url: 'https://www.naukri.com/job-listings-ai-engineer-acme-remote-6-to-9-years-111122223333',
      title: 'AI Engineer',
      workMode: 'Remote',
      experienceMin: 6,
      experienceMax: 9,
      salaryMinLakhs: 30,
      salaryMaxLakhs: 40,
      postedAt: '2026-09-23',
      skills: ['Python', 'LLM'],
      externalApply: null,
    });
  });

  it('rejects cards without a title, company or link', () => {
    expect(normalizeCard({ title: 'AI Engineer', company: 'Acme' })).toBeNull();
    expect(normalizeCard({ title: ' ', company: 'Acme', url: '/job-listings-x-111122223333' })).toBeNull();
  });
});

describe('htmlToText', () => {
  it('keeps paragraph and list structure and decodes entities', () => {
    const html = '<p><strong>Role</strong>: AI&nbsp;Engineer</p><ul><li>React &amp; TypeScript</li><li>RAG</li></ul>Tools &#8211; &lt;LLM&gt;';
    expect(htmlToText(html)).toBe('Role: AI Engineer\n\n- React & TypeScript\n- RAG\nTools – <LLM>');
  });
});
