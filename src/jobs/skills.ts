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
};

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
