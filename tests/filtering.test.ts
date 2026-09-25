import { describe, expect, it } from 'vitest';
import { hardFilterReason, locationMatches, type FilterableJob } from '../src/jobs/filtering.ts';
import { testProfile } from './fixtures.ts';

const job = (overrides: Partial<FilterableJob>): FilterableJob => ({
  title: 'Full Stack AI Engineer',
  location: 'Bengaluru',
  workMode: 'Office',
  experienceMin: 5,
  experienceMax: 10,
  skills: [],
  ...overrides,
});

describe('locationMatches', () => {
  const preferred = testProfile.preferredLocations;
  it.each([
    ['Remote', 'Remote', true],
    ['Hybrid - Bengaluru', 'Hybrid', true],
    ['Kolkata, Hyderabad', 'Office', true],
    ['Greater Noida', 'Office', true],
    ['Delhi / NCR', 'Office', true],
    ['Gurgaon', 'Office', true],
    ['Chennai', 'Office', false],
    ['Hybrid - Mumbai (All Areas)', 'Hybrid', false],
  ] as const)('%s', (location, workMode, expected) => {
    expect(locationMatches({ location, workMode }, preferred)).toBe(expected);
  });

  it('is unknown when the job has no location', () => {
    expect(locationMatches({ location: null, workMode: null }, preferred)).toBeNull();
  });
});

describe('hardFilterReason', () => {
  // Titles taken from real Naukri results for AI / full stack searches.
  it.each([
    'Full-Stack AI Engineer / Data Scientist - Agentic Systems',
    'Artificial Intelligence Engineer',
    'MERN with GEN AI Engineer',
    'GenAI Data Scientist - PAN INDIA',
    'ReactJS Engineer',
    'Angular Developer_Q227',
    'Lead Analyst - React JS Developer',
    'Frontend Developer / Engineer (React.js)',
    'Python Software Developer',
    'Fullstack Engineer - Only Immediate joiners',
    'UI/UX Developer',
    'Sr Software Engineer - Web',
    'Freelance Agent Evaluation Engineer',
  ])('keeps "%s"', (title) => {
    expect(hardFilterReason(job({ title }), testProfile)).toBeNull();
  });

  it.each(['Data Scientist', 'Data Engineer', 'Senior Moodle / Totara Developer', 'AEM Developer', '.NET Software Developer', 'Skywise Developer'])(
    'rejects "%s"',
    (title) => {
      expect(hardFilterReason(job({ title }), testProfile)).toBe('Title does not match your target roles or skills');
    },
  );

  it('lets the listed skills decide for generic titles', () => {
    expect(hardFilterReason(job({ title: 'Senior Software Engineer', skills: ['.NET', 'Node.js', 'React.js'] }), testProfile)).toBeNull();
    expect(hardFilterReason(job({ title: 'Software Engineer', skills: ['Java', 'Spring Boot', 'Javascript'] }), testProfile)).not.toBeNull();
    expect(hardFilterReason(job({ title: 'Sr. Developer', skills: ['Ai', 'Css', 'Finance'] }), testProfile)).not.toBeNull();
  });

  it('rejects experience ranges outside the profile limits', () => {
    expect(hardFilterReason(job({ experienceMin: 13, experienceMax: 18 }), testProfile)).toBe('Needs 13+ years; your maximum is 12');
    expect(hardFilterReason(job({ experienceMin: 2, experienceMax: 5 }), testProfile)).toBe('Aimed at up to 5 years; your minimum is 6');
    expect(hardFilterReason(job({ experienceMin: null, experienceMax: null }), testProfile)).toBeNull();
  });

  it('rejects locations outside the preferred list, but never remote jobs', () => {
    expect(hardFilterReason(job({ location: 'Chennai' }), testProfile)).toBe('Not in your preferred locations (Chennai)');
    expect(hardFilterReason(job({ location: 'Remote', workMode: 'Remote' }), testProfile)).toBeNull();
  });
});
