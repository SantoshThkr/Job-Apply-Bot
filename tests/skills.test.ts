import { describe, expect, it } from 'vitest';
import { skillKey, skillMatcher } from '../src/jobs/skills.ts';
import { testProfile } from './fixtures.ts';

describe('skillKey', () => {
  it('treats spelling variants and filler words as the same skill', () => {
    expect(skillKey('React.js')).toBe(skillKey('React'));
    expect(skillKey('ReactJS')).toBe(skillKey('React'));
    expect(skillKey('Strong React.js skills')).toBe(skillKey('React'));
    expect(skillKey('3+ years of Python programming')).toBe(skillKey('Python'));
    expect(skillKey('Python (FastAPI)')).toBe(skillKey('Python'));
    expect(skillKey('Node.Js')).toBe(skillKey('Node.js'));
    expect(skillKey('Fast API')).toBe(skillKey('FastAPI'));
    expect(skillKey('Ci/Cd')).toBe(skillKey('CI/CD'));
  });

  it('keeps different skills apart', () => {
    expect(skillKey('JavaScript')).not.toBe(skillKey('Java'));
    expect(skillKey('React Native')).not.toBe(skillKey('React'));
    expect(skillKey('AWS Bedrock')).not.toBe(skillKey('AWS'));
  });
});

describe('skillMatcher', () => {
  const coveredBy = skillMatcher(testProfile);

  it('matches exact names, variants and built-in aliases', () => {
    expect(coveredBy('React.js')).toBe('React');
    expect(coveredBy('Large Language Models')).toBe('LLM');
    expect(coveredBy('Retrieval Augmented Generation')).toBe('RAG');
    expect(coveredBy('GenAI')).toBe('Generative AI');
    expect(coveredBy('Postgres')).toBe('PostgreSQL');
  });

  it('never lets a framework be covered by its language or a broader area', () => {
    expect(coveredBy('LangGraph')).toBeNull();
    expect(coveredBy('AWS Bedrock')).toBeNull();
    expect(coveredBy('React Native')).toBeNull();
    expect(coveredBy('Vue')).toBeNull();
  });

  it('accepts any listed alternative', () => {
    expect(coveredBy('React/Angular')).toBe('React');
    expect(coveredBy('Java or Python')).toBe('Python');
    expect(coveredBy('Java/Kotlin')).toBeNull();
  });

  it('uses aliases configured in the profile', () => {
    expect(coveredBy('Express')).toBeNull();
    const configured = skillMatcher({ ...testProfile, skillAliases: { 'Node.js': ['Express', 'NestJS'] } });
    expect(configured('Express.js')).toBe('Node.js');
    expect(configured('NestJS')).toBe('Node.js');
  });
});
