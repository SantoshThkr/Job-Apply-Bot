import type { MatchEvidence, SkillEvidence } from '../ai/schemas.ts';
import type { JobProfile, Profile } from '../config.ts';
import type { MatchBand } from '../domain.ts';
import { locationMatches } from './filtering.ts';
import { mentionedIn, skillKey, skillMatcher } from './skills.ts';
import type { WorkMode } from './normalization.ts';

// The model supplies evidence; the score is always calculated here so it is reproducible and explainable.
// Experience is deliberately not a component: it never keeps a job from being applied to. AI focus
// only counts for job profiles marked `ai`, and the weights are rescaled when it doesn't.
export const WEIGHTS = { role: 0.3, skills: 0.35, ai: 0.2, location: 0.1, other: 0.05 } as const;
type Component = keyof typeof WEIGHTS;

const ROLE_SCORES = { STRONG: 1, PARTIAL: 0.6, WEAK: 0.2, NONE: 0 } as const;
const AI_FOCUS_SCORES = { CORE: 1, SIGNIFICANT: 0.7, MINOR: 0.3, NONE: 0 } as const;
const REQUIREMENT_SCORES = { YES: 1, UNKNOWN: 0.5, NO: 0 } as const;
// Used when the evidence can't tell either way, so missing data neither helps nor sinks a job.
const NEUTRAL = 0.5;
const REVIEW_THRESHOLD = 60;

export type MatchStatus = 'SHORTLISTED' | 'REVIEW' | 'SKIPPED';

export interface JobFacts {
  location: string | null;
  workMode: WorkMode | null;
  // The posting's own words, to check the model's skill lists against.
  title?: string;
  description?: string | null;
  skills?: string[];
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

function dedupe(items: SkillEvidence[], alreadyListed: Set<string>): SkillEvidence[] {
  return items.filter((item) => {
    const key = skillKey(item.skill);
    if (!key || alreadyListed.has(key)) return false;
    alreadyListed.add(key);
    return true;
  });
}

function weightedScore(breakdown: Record<Component, number>, countAi: boolean): number {
  const components = (Object.keys(WEIGHTS) as Component[]).filter((key) => countAi || key !== 'ai');
  const total = components.reduce((sum, key) => sum + WEIGHTS[key], 0);
  const weighted = components.reduce((sum, key) => sum + WEIGHTS[key] * breakdown[key], 0) / total;
  // toFixed first, so an exact .5 always rounds up instead of depending on floating-point noise.
  return Math.round(Number((weighted * 100).toFixed(6)));
}

export function scoreMatch({
  evidence,
  job,
  profile,
  minMatchScore,
  jobProfiles = [],
}: {
  evidence: MatchEvidence;
  job: JobFacts;
  profile: Profile;
  minMatchScore: number;
  // The job profiles the job belongs to. It gets the better score of an AI and a non-AI profile.
  jobProfiles?: Pick<JobProfile, 'ai'>[];
}): MatchResult {
  // Coverage is decided here from the job's skill names, never from the model's candidateSkill claim,
  // so a model mapping "LangGraph" to "Python" can't inflate the score.
  const coveredBy = skillMatcher(profile);
  const covered = (item: SkillEvidence) => coveredBy(item.skill) !== null;
  const coverage = (items: SkillEvidence[]) => items.filter(covered).length / items.length;

  // Only skills the posting itself names count. A small model sometimes pads the lists with the
  // candidate's own skills; without a description there is nothing to check them against.
  const named = job.description ? mentionedIn([job.title ?? '', job.description, ...(job.skills ?? [])].join('\n')) : () => true;
  const fromPosting = (items: SkillEvidence[]) => items.filter((item) => named(item.skill));

  const listed = new Set<string>();
  const required = dedupe(fromPosting(evidence.requiredSkills), listed);
  const preferred = dedupe(fromPosting(evidence.preferredSkills), listed);
  const optional = dedupe(fromPosting(evidence.optionalSkills), listed);

  let skills = NEUTRAL;
  if (required.length && preferred.length) skills = 0.8 * coverage(required) + 0.2 * coverage(preferred);
  else if (required.length) skills = coverage(required);
  else if (preferred.length) skills = coverage(preferred);

  const location = locationMatches(job, profile.preferredLocations);
  const other = evidence.otherRequirements.length
    ? evidence.otherRequirements.reduce((sum, r) => sum + REQUIREMENT_SCORES[r.met], 0) / evidence.otherRequirements.length
    : 1;

  const breakdown: Record<Component, number> = {
    role: ROLE_SCORES[evidence.roleRelevance],
    skills,
    ai: AI_FOCUS_SCORES[evidence.aiFocus],
    location: location === null ? NEUTRAL : Number(location),
    other,
  };
  const aiVariants = new Set(jobProfiles.length ? jobProfiles.map((p) => p.ai) : [false]);
  const score = Math.max(...[...aiVariants].map((countAi) => weightedScore(breakdown, countAi)));

  // Location is only 10% of the score, so a strong role elsewhere can outscore it. The score stays as
  // calculated; the job just isn't shortlisted automatically.
  const holdReason = location === false ? `Not in your preferred locations (${job.location})` : null;
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
    locationMatch: location,
    redFlags: evidence.redFlags.map((f) => f.trim()).filter(Boolean),
    reason: evidence.reason.trim(),
  };
}
