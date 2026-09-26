import { describe, expect, it } from 'vitest';
import { hardFilterReason, locationMatches, matchingProfiles, type FilterableJob } from '../src/jobs/filtering.ts';
import { testJobProfiles, testProfile } from './fixtures.ts';

const job = (overrides: Partial<FilterableJob>): FilterableJob => ({
  title: 'Full Stack AI Engineer',
  location: 'Bengaluru',
  workMode: 'Office',
  skills: [],
  ...overrides,
});

const reasonFor = (overrides: Partial<FilterableJob>) => {
  const candidate = job(overrides);
  return hardFilterReason(candidate, testProfile, matchingProfiles(candidate, testJobProfiles));
};
const profilesOf = (title: string, skills: string[] = []) => matchingProfiles({ title, skills }, testJobProfiles);

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
    expect(reasonFor({ title })).toBeNull();
  });

  it.each(['Data Scientist', 'Data Engineer', 'Senior Moodle / Totara Developer', 'AEM Developer', '.NET Software Developer', 'Skywise Developer'])(
    'rejects "%s"',
    (title) => {
      expect(reasonFor({ title })).toBe('Title matches none of your job profiles');
    },
  );

  it('lets the listed skills decide for generic titles', () => {
    expect(reasonFor({ title: 'Senior Software Engineer', skills: ['.NET', 'Node.js', 'React.js'] })).toBeNull();
    expect(reasonFor({ title: 'Software Engineer', skills: ['Java', 'Spring Boot', 'Javascript'] })).not.toBeNull();
    expect(reasonFor({ title: 'Sr. Developer', skills: ['Ai', 'Css', 'Finance'] })).not.toBeNull();
  });

  it('never rejects a job for its experience range', () => {
    // FilterableJob has no experience at all: the card's "0-2 Yrs" or "15+ Yrs" can't reach this check.
    expect(reasonFor({ title: 'Junior React Developer' })).toBeNull();
    expect(reasonFor({ title: 'Principal Frontend Architect (15+ years)' })).toBeNull();
  });

  it('rejects locations outside the preferred list, but never remote jobs', () => {
    expect(reasonFor({ location: 'Chennai' })).toBe('Not in your preferred locations (Chennai)');
    expect(reasonFor({ location: 'Remote', workMode: 'Remote' })).toBeNull();
  });
});

describe('matchingProfiles', () => {
  it('puts a job in every profile its title names', () => {
    expect(profilesOf('Senior React Developer')).toEqual(['frontend', 'react', 'broad']);
    expect(profilesOf('Angular Developer')).toEqual(['frontend', 'angular', 'broad']);
    expect(profilesOf('Full Stack AI Engineer')).toEqual(['fullstack', 'fullstack-ai', 'broad']);
    expect(profilesOf('Frontend Engineer')).toEqual(['frontend', 'broad']);
    expect(profilesOf('Web Developer')).toEqual(['web', 'broad']);
    expect(profilesOf('Generative AI Engineer')).toEqual(['fullstack-ai']);
  });

  it('keeps plain React jobs out of the AI profile', () => {
    expect(profilesOf('React.js Developer')).not.toContain('fullstack-ai');
  });

  it('keeps unrelated stacks out of the broad profile', () => {
    expect(profilesOf('Java Full Stack Developer')).toEqual(['fullstack']);
    expect(profilesOf('Senior DevOps Engineer')).toEqual([]);
    expect(profilesOf('JavaScript Developer')).toEqual(['frontend', 'web', 'broad']);
  });

  it('reads profiles from configuration, so new ones need no code', () => {
    const vue = { id: 'vue', name: 'Vue Developer', keywords: ['Vue Developer'], skills: ['Vue', 'Nuxt'], exclude: [], ai: false };
    expect(matchingProfiles({ title: 'Nuxt Engineer', skills: [] }, [vue])).toEqual(['vue']);
  });
});
