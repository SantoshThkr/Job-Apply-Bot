import { describe, expect, it } from 'vitest';
import { bandFor, scoreMatch, type JobFacts } from '../src/jobs/scoring.ts';
import { evidence, skills, testProfile } from './fixtures.ts';

const bangaloreHybrid: JobFacts = { location: 'Hybrid - Bengaluru', workMode: 'Hybrid' };
const AI_PROFILE = [{ ai: true }];
const FRONTEND_PROFILE = [{ ai: false }];
const score = (ev: ReturnType<typeof evidence>, job: Partial<JobFacts> = {}, minMatchScore = 75, jobProfiles = AI_PROFILE) =>
  scoreMatch({ evidence: ev, job: { ...bangaloreHybrid, ...job }, profile: testProfile, minMatchScore, jobProfiles });

// Weights: role 30, skills 35, AI focus 20, location 10, other requirements 5. For a profile that isn't
// about AI, the AI share drops out and the rest is divided by 0.8. Experience is not a component.
// Each expected score below is worked out by hand from those weights.
describe('scoreMatch on realistic postings', () => {
  const fullStackAi = evidence({
    requiredSkills: skills(['React', 'React'], ['TypeScript', 'TypeScript'], ['Python', 'Python'], ['FastAPI', 'FastAPI'], ['RAG', 'RAG'], ['LLM APIs', 'LLM']),
    preferredSkills: skills(['LangGraph', null], ['Docker', 'Docker']),
  });

  it('senior full stack AI engineer with React, Python, FastAPI and RAG', () => {
    // skills 0.8 × 6/6 + 0.2 × 1/2 = 0.9 → 30 + 31.5 + 20 + 10 + 5 = 96.5
    const result = score(fullStackAi);
    expect(result).toMatchObject({ score: 97, band: 'HIGH_MATCH', status: 'SHORTLISTED', missingSkills: [], missingPreferredSkills: ['LangGraph'] });
    expect(result.matchedSkills).toEqual(['React', 'TypeScript', 'Python', 'FastAPI', 'RAG', 'LLM APIs', 'Docker']);
  });

  it('a React role with no AI work tops out at MATCH for the AI profile, and scores in full for a frontend one', () => {
    const react = evidence({ aiFocus: 'NONE', requiredSkills: skills(['React', 'React'], ['TypeScript', 'TypeScript'], ['JavaScript', 'JavaScript'], ['Next.js', 'Next.js']) });
    const pune = { location: 'Pune', workMode: 'Office' } as const;
    // AI profile: 30 + 35 + 0 + 10 + 5; frontend profile: (30 + 35 + 10 + 5) / 0.8
    expect(score(react, pune)).toMatchObject({ score: 80, band: 'MATCH', status: 'SHORTLISTED' });
    expect(score(react, pune, 75, FRONTEND_PROFILE)).toMatchObject({ score: 100, band: 'HIGH_MATCH' });
    // In both kinds of profile, the job gets the better of the two.
    expect(score(react, pune, 75, [{ ai: true }, { ai: false }]).score).toBe(100);
  });

  it('Java and Spring Boot full stack role with an AI mention', () => {
    // role 0.2, AI 0.3, skills 1/5 → 6 + 7 + 6 + 10 + 5
    const result = score(
      evidence({
        roleRelevance: 'WEAK',
        aiFocus: 'MINOR',
        requiredSkills: skills(['Java', null], ['Spring Boot', null], ['Microservices', null], ['Angular', 'Angular'], ['SQL', null]),
      }),
    );
    expect(result).toMatchObject({ score: 34, band: 'SKIP', status: 'SKIPPED', missingSkills: ['Java', 'Spring Boot', 'Microservices', 'SQL'] });
  });

  it('data scientist role training ML models', () => {
    // skills 0.8 × 1/5 + 0.2 × 1/1 = 0.36; unmet degree requirement → other 0 → 6 + 12.6 + 20 + 10 + 0
    const result = score(
      evidence({
        roleRelevance: 'WEAK',
        requiredSkills: skills(['Python', 'Python'], ['PyTorch', null], ['TensorFlow', null], ['Statistics', null], ['SQL', null]),
        preferredSkills: skills(['LLMs', 'LLM']),
        otherRequirements: [{ requirement: "Master's degree in Statistics", met: 'NO' }],
      }),
    );
    expect(result).toMatchObject({ score: 49, band: 'SKIP', status: 'SKIPPED' });
  });

  it('GenAI role where the model over-claims skills the profile does not list', () => {
    // "LangGraph" and "Kubernetes" are not in the profile, so those claims are ignored: skills 0.8 × 3/4 = 0.6
    // → 30 + 21 + 20 + 10 + 5
    const result = score(
      evidence({
        requiredSkills: skills(['Python', 'Python'], ['LangGraph', 'LangGraph'], ['RAG', 'RAG'], ['FastAPI', 'FastAPI']),
        preferredSkills: skills(['Kubernetes', 'Kubernetes']),
      }),
      { location: 'Remote', workMode: 'Remote' },
    );
    expect(result).toMatchObject({ score: 86, band: 'MATCH', missingSkills: ['LangGraph'], missingPreferredSkills: ['Kubernetes'] });
  });

  it('senior Angular developer missing one required library: REVIEW for the AI profile, shortlisted for Angular', () => {
    const angular = evidence({ aiFocus: 'NONE', requiredSkills: skills(['Angular', 'Angular'], ['TypeScript', 'TypeScript'], ['RxJS', null]) });
    const hyderabad = { location: 'Hyderabad', workMode: 'Office' } as const;
    // skills 2/3: 30 + 23.3 + 0 + 10 + 5 = 68.3, or 68.3 / 0.8 = 85.4 without the AI share
    expect(score(angular, hyderabad)).toMatchObject({ score: 68, band: 'REVIEW', status: 'REVIEW', holdReason: null });
    expect(score(angular, hyderabad, 75, FRONTEND_PROFILE)).toMatchObject({ score: 85, band: 'MATCH', status: 'SHORTLISTED' });
  });

  it('never holds back or marks down a role for the experience it asks for', () => {
    // role 0.6 → 18 + 35 + 20 + 10 + 5, whatever the posting says about years
    const ask = (statedMinimumYears: number | null) =>
      score(evidence({ roleRelevance: 'PARTIAL', statedMinimumYears, requiredSkills: skills(['Python', 'Python'], ['LLM', 'LLM'], ['Agents', 'AI Agents']) }));
    expect(ask(12)).toMatchObject({ score: 88, band: 'MATCH', status: 'SHORTLISTED', holdReason: null });
    expect([ask(0), ask(1), ask(20), ask(null)].map((r) => r.score)).toEqual([88, 88, 88, 88]);
  });

  it('holds a strong role outside the preferred locations', () => {
    const result = score(evidence({ requiredSkills: skills(['React', 'React'], ['Python', 'Python']) }), { location: 'Chennai', workMode: 'Office' });
    expect(result).toMatchObject({
      score: 90,
      band: 'HIGH_MATCH',
      status: 'REVIEW',
      locationMatch: false,
      holdReason: 'Not in your preferred locations (Chennai)',
    });
  });

  it('vague posting with nothing concrete scores neutral and is not shortlisted', () => {
    // skills and location unknown → 0.5 each: 18 + 17.5 + 14 + 5 + 5 = 59.5
    const result = score(evidence({ roleRelevance: 'PARTIAL', aiFocus: 'SIGNIFICANT', redFlags: ['Vague, copy-pasted description'] }), {
      location: null,
      workMode: null,
    });
    expect(result).toMatchObject({ score: 60, band: 'REVIEW', status: 'REVIEW', redFlags: ['Vague, copy-pasted description'] });
  });

  it('reports red flags without changing the score', () => {
    const flagged = score({ ...fullStackAi, redFlags: [' Immediate joiners only ', ''] });
    expect(flagged).toMatchObject({ score: 97, redFlags: ['Immediate joiners only'] });
  });

  it('respects a stricter MIN_MATCH_SCORE', () => {
    const result = score(
      evidence({ aiFocus: 'NONE', requiredSkills: skills(['React', 'React']) }),
      { location: 'Pune', workMode: 'Office' },
      85,
    );
    expect(result).toMatchObject({ score: 80, status: 'REVIEW', holdReason: null });
  });

  it('ignores a model mapping a framework onto a real but different profile skill', () => {
    // The model claims Python covers LangGraph and "AI Agents" covers CrewAI; neither relationship is allowed.
    // It also missed that "Large Language Models" is the profile's "LLM", which the matcher catches.
    const result = score(
      evidence({
        requiredSkills: skills(['LangGraph', 'Python'], ['CrewAI', 'AI Agents'], ['Python', 'Python'], ['Large Language Models', null]),
      }),
    );
    expect(result.breakdown.skills).toBe(0.5);
    expect(result.matchedSkills).toEqual(['Python', 'Large Language Models']);
    expect(result.missingSkills).toEqual(['LangGraph', 'CrewAI']);
  });

  it('drops skills the posting never names, which a small model copies from the candidate profile', () => {
    const posting = { title: 'React Developer', description: 'Build React and TypeScript screens. Node.js APIs are a plus.', skills: ['React'] };
    const padded = evidence({
      requiredSkills: skills(['React', 'React'], ['TypeScript', 'TypeScript'], ['Kubernetes', null]),
      preferredSkills: skills(['Node.js', 'Node.js'], ['LangGraph', null]),
      optionalSkills: skills(['PostgreSQL', 'PostgreSQL'], ['Docker', 'Docker']),
    });
    const result = score(padded, posting);
    expect(result.matchedSkills).toEqual(['React', 'TypeScript', 'Node.js']);
    expect(result.missingSkills).toEqual([]);
    expect(result.missingPreferredSkills).toEqual([]);
    expect(result.breakdown.skills).toBe(1);
    // Without a description there is nothing to check against, so the lists are taken as given.
    expect(score(padded).missingSkills).toEqual(['Kubernetes']);
  });

  it('counts a skill listed twice only once', () => {
    const result = score(
      evidence({
        requiredSkills: skills(['React', 'React'], ['React.js', 'React']),
        preferredSkills: skills(['ReactJS', 'React'], ['GraphQL', null]),
      }),
    );
    expect(result.breakdown.skills).toBe(0.8);
    expect(result.matchedSkills).toEqual(['React']);
    expect(result.missingPreferredSkills).toEqual(['GraphQL']);
  });
});

describe('scoring helpers', () => {
  it('bands scores', () => {
    expect([100, 90, 89, 75, 74, 60, 59, 0].map(bandFor)).toEqual([
      'HIGH_MATCH',
      'HIGH_MATCH',
      'MATCH',
      'MATCH',
      'REVIEW',
      'REVIEW',
      'SKIP',
      'SKIP',
    ]);
  });

  it('reports the components without experience', () => {
    expect(Object.keys(score(evidence()).breakdown)).toEqual(['role', 'skills', 'ai', 'location', 'other']);
  });
});
