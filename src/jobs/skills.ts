import type { Profile } from '../config.ts';

// Words that describe how a skill is used rather than which skill it is ("3+ years of Python programming").
const FILLER = new Set(
  (
    'experience experienced development developing programming skills skill strong solid good handson hands on ' +
    'knowledge proficiency proficient expertise expert working familiarity familiar with in of the using ' +
    'years year yrs plus framework frameworks library libraries language languages'
  ).split(' '),
);

// "React.js", "ReactJS", "Strong React skills" and "React" compare equal; "React Native" does not.
export function skillKey(skill: string): string {
  const key = skill
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .filter((word) => !FILLER.has(word.replace(/[^a-z0-9]/g, '')) && !/^\d+\+?$/.test(word))
    .join('')
    .replace(/[^a-z0-9+#]/g, '');
  return key.length > 4 && key.endsWith('js') ? key.slice(0, -2) : key;
}

// Other names for the same skill. Deliberately narrow: a framework is never covered by the language
// or the broader area it belongs to (LangGraph is not Python, AWS Bedrock is not OpenAI).
const BUILT_IN_ALIASES: Record<string, string[]> = {
  LLM: ['LLMs', 'Large Language Model', 'Large Language Models', 'LLM API', 'LLM APIs'],
  'Generative AI': ['GenAI', 'Gen AI', 'Generative Artificial Intelligence'],
  RAG: ['Retrieval Augmented Generation', 'Retrieval-Augmented Generation'],
  'AI Agents': ['AI Agent', 'Agents', 'Agentic AI', 'Autonomous Agents'],
  'Prompt Engineering': ['Prompting', 'Prompt Design'],
  'Function Calling': ['Tool Calling', 'Tool Use'],
  'Vector Search': ['Vector Database', 'Vector Databases', 'Vector DB', 'Vector Store', 'Semantic Search'],
  OpenAI: ['OpenAI API', 'GPT', 'GPT-4', 'ChatGPT API'],
  'Azure OpenAI': ['Azure OpenAI Service'],
  'Streaming AI Responses': ['Streaming Responses', 'LLM Streaming'],
  JavaScript: ['JS', 'ES6', 'ECMAScript'],
  TypeScript: ['TS'],
  'REST APIs': ['REST', 'REST API', 'RESTful', 'RESTful API', 'RESTful APIs', 'RESTful Services'],
  PostgreSQL: ['Postgres'],
  MongoDB: ['Mongo'],
  Kubernetes: ['K8s'],
  AWS: ['Amazon Web Services'],
  Azure: ['Microsoft Azure'],
  'CI/CD': ['Continuous Integration', 'CI/CD Pipelines'],
  WebSockets: ['WebSocket', 'Web Sockets'],
  SSE: ['Server-Sent Events', 'Server Sent Events'],
  'Micro Frontends': ['Micro-Frontends', 'Microfrontends', 'Micro Frontend'],
  'Redux Toolkit': ['Redux', 'RTK'],
  'Apollo Client': ['Apollo', 'Apollo GraphQL'],
  'Tailwind CSS': ['Tailwind'],
  'Material UI': ['MUI'],
};

// "HTML5" and "HTML", "CSS3" and "CSS" name the same skill.
const withoutVersion = (key: string) => (/^[a-z]+\d+$/.test(key) ? [key, key.replace(/\d+$/, '')] : [key]);

// Each built-in skill with its other names, reachable from any of them.
const ALIAS_GROUPS = new Map<string, string[]>();
for (const [skill, aliases] of Object.entries(BUILT_IN_ALIASES)) {
  const keys = [skill, ...aliases].map(skillKey);
  for (const key of keys) ALIAS_GROUPS.set(key, keys);
}

const words = (text: string) => text.replace(/[()[\]{}/|,;:!?"'•]/g, ' ').split(/\s+/).filter(Boolean);

// Returns a function that tells whether the posting names a skill, under any spelling skillKey treats
// as equal or a built-in alias, so "Experience with React.js (Redux)" names both React and Redux. A
// phrase of several words also counts when each of its words is in the posting: the model rewords
// requirements ("Reactive data flows with RxJS") and sometimes copies whole sentences.
export function mentionedIn(text: string): (skill: string) => boolean {
  const posting = words(text);
  const keys = new Set<string>();
  for (let i = 0; i < posting.length; i++) {
    for (let n = 1; n <= 6 && i + n <= posting.length; n++) {
      for (const key of withoutVersion(skillKey(posting.slice(i, i + n).join(' ')))) if (key) keys.add(key);
    }
  }
  const has = (key: string) => withoutVersion(key).some((k) => keys.has(k));
  const named = (name: string) => withoutVersion(skillKey(name)).some((key) => (ALIAS_GROUPS.get(key) ?? [key]).some(has));
  const everyWord = (name: string) => {
    const parts = words(name).map(skillKey).filter(Boolean);
    return parts.length > 1 && parts.every(has);
  };
  return (skill) => [skill, ...skill.split(/\s*(?:\/|\||\bor\b)\s*/i)].some((name) => named(name) || everyWord(name));
}

// Returns a function that names the profile skill covering a job skill, or null. Only exact names,
// spelling variants and configured aliases count; nothing the model claims is taken on trust.
export function skillMatcher(profile: Pick<Profile, 'primarySkills' | 'secondarySkills' | 'skillAliases'>) {
  const builtIn = new Map(Object.entries(BUILT_IN_ALIASES).map(([skill, aliases]) => [skillKey(skill), aliases]));
  const byKey = new Map<string, string>();
  for (const skill of [...profile.primarySkills, ...profile.secondarySkills]) {
    const configured = Object.entries(profile.skillAliases).find(([name]) => name.toLowerCase() === skill.toLowerCase())?.[1] ?? [];
    for (const name of [skill, ...(builtIn.get(skillKey(skill)) ?? []), ...configured]) {
      const key = skillKey(name);
      if (key && !byKey.has(key)) byKey.set(key, skill);
    }
  }

  return (jobSkill: string): string | null => {
    // "React/Angular" or "Python or Java": any listed alternative is enough.
    const alternatives = [jobSkill, ...jobSkill.split(/\s*(?:\/|\||\bor\b)\s*/i)];
    for (const alternative of alternatives) {
      const skill = byKey.get(skillKey(alternative));
      if (skill) return skill;
    }
    return null;
  };
}
