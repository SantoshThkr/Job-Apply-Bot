import { describe, expect, it } from 'vitest';
import { bandFor, experienceFit, scoreMatch, type JobFacts } from '../src/jobs/scoring.ts';
import { evidence, skills, testProfile } from './fixtures.ts';

const bangaloreHybrid: JobFacts = { experienceMin: 6, experienceMax: 10, location: 'Hybrid - Bengaluru', workMode: 'Hybrid' };
const score = (ev: ReturnType<typeof evidence>, job: Partial<JobFacts> = {}, minMatchScore = 75) =>
  scoreMatch({ evidence: ev, job: { ...bangaloreHybrid, ...job }, profile: testProfile, minMatchScore });

// Weights: role 25, skills 30, AI focus 20, experience 10, location 10, other requirements 5.
// Each expected score below is worked out by hand from those weights.
describe('scoreMatch on realistic postings', () => {
  const fullStackAi = evidence({
    requiredSkills: skills(['React', 'React'], ['TypeScript', 'TypeScript'], ['Python', 'Python'], ['FastAPI', 'FastAPI'], ['RAG', 'RAG'], ['LLM APIs', 'LLM']),
    preferredSkills: skills(['LangGraph', null], ['Docker', 'Docker']),
  });

  it('senior full stack AI engineer with React, Python, FastAPI and RAG', () => {
    // skills 0.8 × 6/6 + 0.2 × 1/2 = 0.9 → 25 + 27 + 20 + 10 + 10 + 5
    const result = score(fullStackAi);
    expect(result).toMatchObject({ score: 97, band: 'HIGH_MATCH', status: 'SHORTLISTED', missingSkills: [], missingPreferredSkills: ['LangGraph'] });
    expect(result.matchedSkills).toEqual(['React', 'TypeScript', 'Python', 'FastAPI', 'RAG', 'LLM APIs', 'Docker']);
  });

  it('senior React developer with no AI work tops out at MATCH', () => {
    const result = score(
      evidence({ aiFocus: 'NONE', requiredSkills: skills(['React', 'React'], ['TypeScript', 'TypeScript'], ['JavaScript', 'JavaScript'], ['Next.js', 'Next.js']) }),
      { location: 'Pune', workMode: 'Office', experienceMin: 5, experienceMax: 9 },
    );
    expect(result).toMatchObject({ score: 80, band: 'MATCH', status: 'SHORTLISTED' });
  });

  it('Java and Spring Boot full stack role with an AI mention', () => {
    // role 0.2, AI 0.3, skills 1/5 → 5 + 6 + 6 + 10 + 10 + 5
    const result = score(
      evidence({
        roleRelevance: 'WEAK',
        aiFocus: 'MINOR',
        requiredSkills: skills(['Java', null], ['Spring Boot', null], ['Microservices', null], ['Angular', 'Angular'], ['SQL', null]),
      }),
    );
    expect(result).toMatchObject({ score: 42, band: 'SKIP', status: 'SKIPPED', missingSkills: ['Java', 'Spring Boot', 'Microservices', 'SQL'] });
  });

  it('data scientist role training ML models', () => {
    // skills 0.8 × 1/5 + 0.2 × 1/1 = 0.36; unmet degree requirement → other 0
    const result = score(
      evidence({
        roleRelevance: 'WEAK',
        requiredSkills: skills(['Python', 'Python'], ['PyTorch', null], ['TensorFlow', null], ['Statistics', null], ['SQL', null]),
        preferredSkills: skills(['LLMs', 'LLM']),
        otherRequirements: [{ requirement: "Master's degree in Statistics", met: 'NO' }],
      }),
    );
    expect(result).toMatchObject({ score: 56, band: 'SKIP', status: 'SKIPPED' });
  });

  it('GenAI role where the model over-claims skills the profile does not list', () => {
    // "LangGraph" and "Kubernetes" are not in the profile, so those claims are ignored: skills 0.8 × 3/4 = 0.6
    const result = score(
      evidence({
        requiredSkills: skills(['Python', 'Python'], ['LangGraph', 'LangGraph'], ['RAG', 'RAG'], ['FastAPI', 'FastAPI']),
        preferredSkills: skills(['Kubernetes', 'Kubernetes']),
      }),
      { location: 'Remote', workMode: 'Remote' },
    );
    expect(result).toMatchObject({ score: 88, band: 'MATCH', missingSkills: ['LangGraph'], missingPreferredSkills: ['Kubernetes'] });
  });

  it('senior Angular developer missing one required library lands in REVIEW', () => {
    const result = score(
      evidence({ aiFocus: 'NONE', requiredSkills: skills(['Angular', 'Angular'], ['TypeScript', 'TypeScript'], ['RxJS', null]) }),
      { location: 'Hyderabad', workMode: 'Office' },
    );
    expect(result).toMatchObject({ score: 70, band: 'REVIEW', status: 'REVIEW', holdReason: null });
  });

  it('holds a well-matched role that needs far more experience', () => {
    // stated 12+ years beats the card's 10; 5 years short → experience 0 → 15 + 30 + 20 + 0 + 10 + 5
    const result = score(
      evidence({ roleRelevance: 'PARTIAL', statedMinimumYears: 12, requiredSkills: skills(['Python', 'Python'], ['LLM', 'LLM'], ['Agents', 'AI Agents']) }),
      { experienceMin: 10, experienceMax: 15 },
    );
    expect(result).toMatchObject({ score: 80, band: 'MATCH', status: 'REVIEW', experienceMatch: false, holdReason: 'Needs 12+ years; you have 7' });
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

  it('vague posting with nothing concrete scores neutral and is skipped', () => {
    // skills, experience and location unknown → 0.5 each: 15 + 15 + 14 + 5 + 5 + 5
    const result = score(evidence({ roleRelevance: 'PARTIAL', aiFocus: 'SIGNIFICANT', redFlags: ['Vague, copy-pasted description'] }), {
      experienceMin: null,
      experienceMax: null,
      location: null,
      workMode: null,
    });
    expect(result).toMatchObject({ score: 59, band: 'SKIP', status: 'SKIPPED', redFlags: ['Vague, copy-pasted description'] });
  });

  it('slightly over-qualified candidate is still shortlisted', () => {
    const result = score(evidence({ requiredSkills: skills(['React', 'React']) }), { experienceMin: 3, experienceMax: 6 });
    expect(result).toMatchObject({ score: 97, status: 'SHORTLISTED', experienceMatch: false });
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

  it('rates experience fit', () => {
    expect(experienceFit(7, 6, 10)).toBe(1);
    expect(experienceFit(7, 8, 12)).toBe(0.5);
    expect(experienceFit(7, 10, 15)).toBe(0);
    expect(experienceFit(7, 3, 5)).toBe(0.7);
    expect(experienceFit(7, 1, 3)).toBe(0.4);
    expect(experienceFit(7, 10, null)).toBe(0);
    expect(experienceFit(7, null, null)).toBeNull();
  });
});
