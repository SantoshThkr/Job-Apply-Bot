import { z } from 'zod';

const skillEvidence = z.object({
  skill: z.string().describe('Skill or technology, named close to the posting wording'),
  candidateSkill: z
    .string()
    .nullable()
    .describe('The profile skill that covers this requirement, copied exactly from the profile, or null'),
});

// What the model reports. The score is computed from this in src/jobs/scoring.ts, never by the model.
export const matchEvidenceSchema = z.object({
  roleRelevance: z.enum(['STRONG', 'PARTIAL', 'WEAK', 'NONE']),
  aiFocus: z.enum(['CORE', 'SIGNIFICANT', 'MINOR', 'NONE']),
  requiredSkills: z.array(skillEvidence),
  preferredSkills: z.array(skillEvidence),
  optionalSkills: z.array(skillEvidence),
  statedMinimumYears: z.number().nullable(),
  otherRequirements: z.array(
    z.object({
      requirement: z.string(),
      met: z.enum(['YES', 'NO', 'UNKNOWN']),
    }),
  ),
  redFlags: z.array(z.string()),
  reason: z.string(),
});

export type MatchEvidence = z.infer<typeof matchEvidenceSchema>;
export type SkillEvidence = z.infer<typeof skillEvidence>;

// What responses are parsed with. Small local models sometimes change case, leave out empty lists,
// or write "" for null; those are harmless. Missing core evidence (role, AI focus, required and
// preferred skills, reason) still fails validation, so nothing is invented on the model's behalf.
const label = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((value) => (typeof value === 'string' ? value.trim().toUpperCase() : value), z.enum(values));
const parsedSkill = z.object({
  skill: z.string(),
  candidateSkill: z.preprocess((value) => (value === '' || value === undefined ? null : value), z.string().nullable()),
});

export const responseEvidenceSchema = z.object({
  roleRelevance: label(['STRONG', 'PARTIAL', 'WEAK', 'NONE']),
  aiFocus: label(['CORE', 'SIGNIFICANT', 'MINOR', 'NONE']),
  requiredSkills: z.array(parsedSkill),
  preferredSkills: z.array(parsedSkill),
  optionalSkills: z.array(parsedSkill).default([]),
  statedMinimumYears: z.number().nullable().default(null),
  otherRequirements: z.array(z.object({ requirement: z.string(), met: label(['YES', 'NO', 'UNKNOWN']) })).default([]),
  redFlags: z.array(z.string()).default([]),
  reason: z.string().trim().min(1),
}) satisfies z.ZodType<MatchEvidence, unknown>;

// OpenAI strict structured outputs need every property required and no extra properties,
// which is what Zod emits for plain objects; the $schema marker is dropped.
const { $schema: _, ...jsonSchema } = z.toJSONSchema(matchEvidenceSchema, { target: 'draft-7' });
export const matchEvidenceJsonSchema = jsonSchema;
