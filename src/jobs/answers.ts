import type { Answer } from '../config.ts';

// Questions and form fields are answered only from your saved answers and your profile. Nothing is
// guessed or generated: anything else sends the application to review.

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\.(?=\s|$)/g, '')
    .trim();

// The answer whose every match phrase appears in the question. With several, the one naming the
// most words wins ("expected ctc" over "ctc"); a tie is ambiguous, so neither is used.
export function findAnswer(question: string, answers: Answer[]): string | null {
  const text = ` ${normalize(question)} `;
  const matches = answers
    .filter((a) => a.match.every((phrase) => text.includes(` ${normalize(phrase)} `)))
    .map((a) => ({ answer: a.answer, weight: a.match.map(normalize).join(' ').split(' ').length }))
    .sort((a, b) => b.weight - a.weight);
  const [best, next] = matches;
  if (!best || (next && next.weight === best.weight && next.answer !== best.answer)) return null;
  return best.answer;
}

// The option that says the same as the answer ("yes" picks "Yes"). Never the closest guess.
export function pickOption(options: string[], answer: string): string | null {
  const wanted = normalize(answer);
  return options.find((option) => normalize(option) === wanted) ?? null;
}

export interface ApplicantFacts {
  name: string;
  firstName?: string;
  lastName?: string;
  experienceYears: number;
  skills: string[];
  email?: string;
  phone?: string;
  currentLocation?: string;
  currentTitle?: string;
  currentCompany?: string;
  noticePeriodDays?: number;
  currentSalary?: string;
  expectedSalary?: string;
}

// Each written so it can't catch a different question: "years of experience in React" is not the
// total, "company name" is not your name, "preferred location" is not your current one.
const FACT_FIELDS: [RegExp, (facts: ApplicantFacts) => string | number | undefined][] = [
  [/^(your |full |candidate )?name$/, (f) => f.name],
  [/^first name$/, (f) => f.firstName],
  [/^(last name|surname)$/, (f) => f.lastName],
  [/\be ?mail( id| address)?\b/, (f) => f.email],
  [/\b(mobile|phone)( number| no)?\b|\bcontact (number|no)\b/, (f) => f.phone],
  [/\bcurrent (city|location)\b|^(city|location)$/, (f) => f.currentLocation],
  [/\bcurrent (designation|role|job title|title)\b|^designation$/, (f) => f.currentTitle],
  [/\bcurrent (company|employer|organi[sz]ation)( name)?\b/, (f) => f.currentCompany],
  [/\b(total|overall) (work |professional )?experience\b|^(years of )?experience( in years)?$/, (f) => f.experienceYears],
  [/\bnotice period\b/, (f) => f.noticePeriodDays],
  [/\bcurrent (ctc|salary)\b/, (f) => f.currentSalary],
  [/\bexpected (ctc|salary)\b/, (f) => f.expectedSalary],
  [/^(key |your )?skills$/, (f) => (f.skills.length ? f.skills.join(', ') : undefined)],
];

// How a number of days or years may be written as a choice.
function spellings(label: string, value: string | number): string[] {
  if (typeof value !== 'number') return [value];
  if (/notice/.test(label)) {
    const months = value / 30;
    return [
      `${value} days`,
      `${value} day`,
      ...(value === 0 ? ['immediate', 'immediately', 'immediate joiner'] : []),
      ...(Number.isInteger(months) && months > 0 ? [`${months} month`, `${months} months`] : []),
    ];
  }
  return [`${value}`, `${value} years`, `${value} year`];
}

// A value from your profile or resume for a field, or null. For a choice, only an option that says
// exactly that value is picked.
export function answerFromFacts(label: string, facts: ApplicantFacts, options: string[] = []): string | null {
  const text = normalize(label.replace(/\*/g, ''));
  for (const [pattern, read] of FACT_FIELDS) {
    if (!pattern.test(text)) continue;
    const value = read(facts);
    if (value === undefined || value === '') return null;
    if (options.length) return spellings(text, value).map((spelling) => pickOption(options, spelling)).find(Boolean) ?? null;
    if (typeof value === 'number' && /notice/.test(text) && !/\bdays?\b/.test(text)) return `${value} days`;
    return String(value);
  }
  return null;
}

// Your configured answer first, then a known fact; for a choice, whichever of them is exactly one of the
// options. null means nobody can answer it safely.
export function answerFor(label: string, answers: Answer[], facts: ApplicantFacts | null, options: string[] = []): string | null {
  const configured = findAnswer(label, answers);
  const fromFacts = () => (facts ? answerFromFacts(label, facts, options) : null);
  if (!options.length) return configured ?? fromFacts();
  return (configured && pickOption(options, configured)) ?? fromFacts();
}
