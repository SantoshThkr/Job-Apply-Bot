import type { JobProfile, Profile } from '../config.ts';
import { canonicalLocation, splitLocations, type WorkMode } from './normalization.ts';
import { skillMatcher } from './skills.ts';

// Cheap, deterministic checks on the search-card data, so unrelated jobs never cost a page load or
// an AI call. Location and experience depend on what the run asks for, so they are checked per run
// (see IN_SCOPE and JOB_CATEGORY in src/db/jobs.ts), not here.

export interface FilterableJob {
  title: string;
  location: string | null;
  workMode: WorkMode | null;
  skills: string[];
}

const REGIONS: Record<string, string[]> = {
  'Delhi NCR': ['Delhi NCR', 'Delhi', 'Noida', 'Greater Noida', 'Gurugram', 'Ghaziabad', 'Faridabad'],
};

function withRegion(city: string): string[] {
  return Object.values(REGIONS).find((members) => members.includes(city)) ?? [city];
}

const isRemote = (location: string) => canonicalLocation(location) === 'Remote';

// The job's cities, canonical, with "Remote" for a remote job.
export function jobCities(job: Pick<FilterableJob, 'location' | 'workMode'>): string[] {
  const cities = splitLocations(job.location);
  if (job.workMode === 'Remote' && !cities.includes('Remote')) cities.push('Remote');
  return [...new Set(cities)];
}

// Every city name that counts as one of the chosen locations ("Delhi NCR" covers Noida and Gurugram).
export function expandLocations(locations: string[]): string[] {
  return [...new Set(locations.flatMap((l) => withRegion(canonicalLocation(l))))];
}

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
  frontend: ['front end', 'ui'],
  'full stack': ['fullstack'],
  react: ['reactjs'],
  'react js': ['reactjs'],
  angular: ['angularjs'],
  'node js': ['nodejs'],
  'next js': ['nextjs'],
};

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();

// What a title has to name to belong to a profile: its keywords without the generic words, and its skills.
function titleTerms(profile: JobProfile): string[] {
  const keywords = profile.keywords.map((keyword) =>
    words(keyword)
      .split(' ')
      .filter((w) => !GENERIC_TITLE_WORDS.has(w))
      .join(' '),
  );
  const terms = [...keywords, ...profile.skills.map(words)].filter(Boolean);
  return [...new Set([...terms, ...terms.flatMap((term) => TITLE_SYNONYMS[term] ?? [])])];
}

export function profileMatches(job: Pick<FilterableJob, 'title' | 'skills'>, profile: JobProfile): boolean {
  const title = ` ${words(job.title)} `;
  const names = (phrase: string) => title.includes(` ${phrase} `);
  if (profile.exclude.some((phrase) => names(words(phrase)))) return false;
  if (titleTerms(profile).some(names)) return true;

  // "Senior Software Engineer" says nothing either way; let the listed skills decide.
  const meaningful = title
    .trim()
    .split(' ')
    .filter((w) => w && !GENERIC_TITLE_WORDS.has(w) && !/^\d+$/.test(w));
  if (meaningful.length > 0) return false;
  const coveredBy = skillMatcher({ primarySkills: profile.skills, secondarySkills: [], skillAliases: {} });
  return new Set(job.skills.map(coveredBy).filter(Boolean)).size >= 2;
}

// Ids of the profiles a job belongs to, in configuration order.
export function matchingProfiles(job: Pick<FilterableJob, 'title' | 'skills'>, profiles: JobProfile[]): string[] {
  return profiles.filter((profile) => profileMatches(job, profile)).map((profile) => profile.id);
}

// Returns why the job is set aside, or null when it is relevant to at least one job profile.
export function hardFilterReason(profiles: string[]): string | null {
  return profiles.length ? null : 'Title matches none of your job profiles';
}
