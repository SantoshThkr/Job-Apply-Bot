import type { Profile } from '../config.ts';
import { canonicalLocation, splitLocations, type WorkMode } from './normalization.ts';
import { skillMatcher } from './skills.ts';

// Stage 1 of matching: cheap, deterministic checks on the search-card data, so obviously wrong jobs
// never cost a page load or an AI call. Deliberately lenient: anything plausible goes on to the AI.

export interface FilterableJob {
  title: string;
  location: string | null;
  workMode: WorkMode | null;
  experienceMin: number | null;
  experienceMax: number | null;
  skills: string[];
}

const REGIONS: Record<string, string[]> = {
  'Delhi NCR': ['Delhi NCR', 'Delhi', 'Noida', 'Greater Noida', 'Gurugram', 'Ghaziabad', 'Faridabad'],
};

function withRegion(city: string): string[] {
  return Object.values(REGIONS).find((members) => members.includes(city)) ?? [city];
}

const isRemote = (location: string) => canonicalLocation(location) === 'Remote';

// null when the job doesn't say where it is.
export function locationMatches(job: Pick<FilterableJob, 'location' | 'workMode'>, preferred: string[]): boolean | null {
  // Anyone can take a remote job, whatever cities they list.
  if (job.workMode === 'Remote') return true;
  const jobCities = splitLocations(job.location);
  if (!jobCities.length) return null;
  const accepted = new Set(preferred.filter((l) => !isRemote(l)).flatMap((l) => withRegion(canonicalLocation(l))));
  return jobCities.some((city) => withRegion(city).some((c) => accepted.has(c)));
}

// Words that say nothing about what kind of role it is.
const GENERIC_TITLE_WORDS = new Set(
  (
    'senior sr junior jr lead principal staff chief head engineer engineers developer developers dev software ' +
    'development programmer consultant specialist associate analyst manager architect member technical team ' +
    'i ii iii iv v and of the with for in a an to or only urgent hiring immediate joiners years yrs'
  ).split(' '),
);

const TITLE_SYNONYMS: Record<string, string[]> = {
  ai: ['artificial intelligence', 'genai', 'gen ai', 'aiml', 'ml', 'machine learning', 'llm', 'agentic', 'agent', 'agents', 'prompt'],
  frontend: ['front end', 'ui', 'web'],
  full: ['fullstack'],
  react: ['reactjs'],
  angular: ['angularjs'],
  'node js': ['nodejs'],
  'next js': ['nextjs'],
};

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();

function titleTerms(profile: Profile): string[] {
  const roleWords = profile.targetRoles.flatMap((role) => words(role).split(' ')).filter((w) => !GENERIC_TITLE_WORDS.has(w));
  const skillPhrases = [...profile.primarySkills, ...profile.secondarySkills].map(words);
  const terms = [...roleWords, ...skillPhrases];
  return [...new Set([...terms, ...terms.flatMap((term) => TITLE_SYNONYMS[term] ?? [])])].filter(Boolean);
}

function titleIsRelevant(title: string, skills: string[], profile: Profile): boolean {
  const normalized = ` ${words(title)} `;
  if (titleTerms(profile).some((term) => normalized.includes(` ${term} `))) return true;

  // "Senior Software Engineer" says nothing either way; let the listed skills decide.
  const meaningful = normalized
    .trim()
    .split(' ')
    .filter((w) => w && !GENERIC_TITLE_WORDS.has(w) && !/^\d+$/.test(w));
  if (meaningful.length > 0) return false;
  const coveredBy = skillMatcher(profile);
  return skills.filter((s) => coveredBy(s)).length >= 2;
}

// Returns why the job is rejected, or null when it should go on to AI analysis.
export function hardFilterReason(job: FilterableJob, profile: Profile): string | null {
  if (job.experienceMin !== null && job.experienceMin > profile.maximumExperience) {
    return `Needs ${job.experienceMin}+ years; your maximum is ${profile.maximumExperience}`;
  }
  if (job.experienceMax !== null && job.experienceMax < profile.minimumExperience) {
    return `Aimed at up to ${job.experienceMax} years; your minimum is ${profile.minimumExperience}`;
  }
  if (locationMatches(job, profile.preferredLocations) === false) {
    return `Not in your preferred locations (${job.location})`;
  }
  if (!titleIsRelevant(job.title, job.skills, profile)) {
    return 'Title does not match your target roles or skills';
  }
  return null;
}
