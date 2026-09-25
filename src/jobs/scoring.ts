import type { MatchEvidence, SkillEvidence } from '../ai/schemas.ts';
import type { Profile } from '../config.ts';
import { locationMatches } from './filtering.ts';
import { skillKey, skillMatcher } from './skills.ts';
import type { WorkMode } from './normalization.ts';

// The model supplies evidence; the score is always calculated here so it is reproducible and explainable.
export const WEIGHTS = { role: 0.25, skills: 0.3, ai: 0.2, experience: 0.1, location: 0.1, other: 0.05 } as const;
type Component = keyof typeof WEIGHTS;

const ROLE_SCORES = { STRONG: 1, PARTIAL: 0.6, WEAK: 0.2, NONE: 0 } as const;
const AI_FOCUS_SCORES = { CORE: 1, SIGNIFICANT: 0.7, MINOR: 0.3, NONE: 0 } as const;
const REQUIREMENT_SCORES = { YES: 1, UNKNOWN: 0.5, NO: 0 } as const;
// Used when the evidence can't tell either way, so missing data neither helps nor sinks a job.
const NEUTRAL = 0.5;
const REVIEW_THRESHOLD = 60;

export type MatchBand = 'HIGH_MATCH' | 'MATCH' | 'REVIEW' | 'SKIP';
export type MatchStatus = 'SHORTLISTED' | 'REVIEW' | 'SKIPPED';

export interface JobFacts {
  experienceMin: number | null;
  experienceMax: number | null;
  location: string | null;
  workMode: WorkMode | null;
}

export interface MatchResult {
  score: number;
  band: MatchBand;
  status: MatchStatus;
  breakdown: Record<Component, number>;
  matchedSkills: string[];
  missingSkills: string[];
  missingPreferredSkills: string[];
  roleMatch: boolean;
  experienceMatch: boolean | null;
  locationMatch: boolean | null;
  // Why a job that scored high enough is held at REVIEW instead of SHORTLISTED.
  holdReason: string | null;
  redFlags: string[];
  reason: string;
}

export function bandFor(score: number): MatchBand {
  if (score >= 90) return 'HIGH_MATCH';
  if (score >= 75) return 'MATCH';
  if (score >= REVIEW_THRESHOLD) return 'REVIEW';
  return 'SKIP';
}

export function experienceFit(years: number, min: number | null, max: number | null): number | null {
  if (min === null && max === null) return null;
  if (min !== null && years < min) return min - years <= 1 ? 0.5 : 0;
  // Over-qualification is a softer mismatch than falling short.
  if (max !== null && years > max) return years - max <= 2 ? 0.7 : 0.4;
  return 1;
}

function dedupe(items: SkillEvidence[], alreadyListed: Set<string>): SkillEvidence[] {
  return items.filter((item) => {
    const key = skillKey(item.skill);
    if (!key || alreadyListed.has(key)) return false;
    alreadyListed.add(key);
    return true;
  });
}

export function scoreMatch({
  evidence,
  job,
  profile,
  minMatchScore,
}: {
  evidence: MatchEvidence;
  job: JobFacts;
  profile: Profile;
  minMatchScore: number;
}): MatchResult {
  // Coverage is decided here from the job's skill names, never from the model's candidateSkill claim,
  // so a model mapping "LangGraph" to "Python" can't inflate the score.
  const coveredBy = skillMatcher(profile);
  const covered = (item: SkillEvidence) => coveredBy(item.skill) !== null;
  const coverage = (items: SkillEvidence[]) => items.filter(covered).length / items.length;

  const listed = new Set<string>();
  const required = dedupe(evidence.requiredSkills, listed);
  const preferred = dedupe(evidence.preferredSkills, listed);
  const optional = dedupe(evidence.optionalSkills, listed);

  let skills = NEUTRAL;
  if (required.length && preferred.length) skills = 0.8 * coverage(required) + 0.2 * coverage(preferred);
  else if (required.length) skills = coverage(required);
  else if (preferred.length) skills = coverage(preferred);

  const minimums = [job.experienceMin, evidence.statedMinimumYears].filter((n): n is number => n !== null);
  const minimumYears = minimums.length ? Math.max(...minimums) : null;
  const experience = experienceFit(profile.experienceYears, minimumYears, job.experienceMax);
  const location = locationMatches(job, profile.preferredLocations);
  const other = evidence.otherRequirements.length
    ? evidence.otherRequirements.reduce((sum, r) => sum + REQUIREMENT_SCORES[r.met], 0) / evidence.otherRequirements.length
    : 1;

  const breakdown: Record<Component, number> = {
    role: ROLE_SCORES[evidence.roleRelevance],
    skills,
    ai: AI_FOCUS_SCORES[evidence.aiFocus],
    experience: experience ?? NEUTRAL,
    location: location === null ? NEUTRAL : Number(location),
    other,
  };
  const weighted = (Object.keys(WEIGHTS) as Component[]).reduce((sum, key) => sum + WEIGHTS[key] * breakdown[key], 0);
  const score = Math.round(weighted * 100);

  // Experience and location are only 20% of the score, so a strong role can outscore a real blocker.
  // The score stays as calculated; the job just isn't shortlisted automatically.
  const holdReason =
    minimumYears !== null && minimumYears - profile.experienceYears >= 2
      ? `Needs ${minimumYears}+ years; you have ${profile.experienceYears}`
      : location === false
        ? `Not in your preferred locations (${job.location})`
        : null;
  let status: MatchStatus = score >= minMatchScore ? 'SHORTLISTED' : score >= REVIEW_THRESHOLD ? 'REVIEW' : 'SKIPPED';
  if (status === 'SHORTLISTED' && holdReason) status = 'REVIEW';

  return {
    score,
    band: bandFor(score),
    status,
    holdReason: status === 'REVIEW' && score >= minMatchScore ? holdReason : null,
    breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, Math.round(v * 100) / 100])) as Record<
      Component,
      number
    >,
    matchedSkills: [...required, ...preferred, ...optional].filter(covered).map((s) => s.skill),
    missingSkills: required.filter((s) => !covered(s)).map((s) => s.skill),
    missingPreferredSkills: preferred.filter((s) => !covered(s)).map((s) => s.skill),
    roleMatch: evidence.roleRelevance === 'STRONG' || evidence.roleRelevance === 'PARTIAL',
    experienceMatch: experience === null ? null : experience === 1,
    locationMatch: location,
    redFlags: evidence.redFlags.map((f) => f.trim()).filter(Boolean),
    reason: evidence.reason.trim(),
  };
}
