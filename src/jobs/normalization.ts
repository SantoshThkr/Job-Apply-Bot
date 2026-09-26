import { NAUKRI_URLS } from '../browser/selectors.ts';

export type WorkMode = 'Remote' | 'Hybrid' | 'Office';

// A job as read off a search results page, before cleanup.
export interface RawCard {
  externalId?: string;
  url?: string;
  title?: string;
  company?: string;
  location?: string;
  experience?: string;
  salary?: string;
  posted?: string | number;
  skills?: string[];
  externalApply?: boolean;
}

export interface JobCard {
  externalId: string | null;
  url: string;
  dedupeKey: string;
  title: string;
  company: string;
  location: string | null;
  workMode: WorkMode | null;
  experience: string | null;
  experienceMin: number | null;
  experienceMax: number | null;
  salary: string | null;
  salaryMinLakhs: number | null;
  salaryMaxLakhs: number | null;
  postedAt: string | null;
  skills: string[];
  externalApply: boolean | null;
}

export interface JobDetails {
  description: string;
  skills: string[];
  employmentType: string | null;
  postedAt: string | null;
  workMode: WorkMode | null;
}

const clean = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim() || null;
const localDate = (date: Date) => date.toLocaleDateString('en-CA');
const DAY_MS = 86_400_000;

// "5-10 Yrs", "10+ Yrs", "Fresher". An open-ended range has max null.
export function parseExperience(label: string | null): { min: number; max: number | null } | null {
  if (!label) return null;
  if (/fresher/i.test(label)) return { min: 0, max: 0 };
  const range = label.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/i);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const openEnded = label.match(/(\d+(?:\.\d+)?)\s*\+/);
  if (openEnded) return { min: Number(openEnded[1]), max: null };
  const single = label.match(/(\d+(?:\.\d+)?)\s*(?:yrs?|years?)\b/i);
  return single ? { min: Number(single[1]), max: Number(single[1]) } : null;
}

// Annual salary in lakhs from labels like "15-22.5 Lacs PA", "1-1.5 Cr PA" or "Not disclosed".
export function parseSalaryLakhs(label: string | null): { min: number; max: number } | null {
  const match = label
    ?.replace(/,/g, '')
    .match(/(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*(lacs?|lakhs?|lpa|cr(?:ores?)?)\b/i);
  if (!match) return null;
  const factor = /^cr/i.test(match[3]!) ? 100 : 1;
  let min = Number(match[1]) * factor;
  const max = Number(match[2] ?? match[1]) * factor;
  // "50,000-1.5 Lacs PA" gives the lower bound in rupees.
  if (min > max) min /= 100_000;
  return { min, max };
}

// Epoch ms from the search API (kept to the second, which "last 24 hours" needs), ISO dates from
// schema.org, or relative labels from job cards. Day labels are approximate: "30+ Days Ago" becomes
// the date 30 days ago.
export function parsePostedDate(value: string | number | null | undefined, now = new Date()): string | null {
  if (typeof value === 'number') return value > 0 ? new Date(value).toISOString() : null;
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const text = value.toLowerCase();
  const hours = text.match(/(\d+)\+?\s*hours? ago/);
  if (hours) return new Date(now.getTime() - Number(hours[1]) * 3_600_000).toISOString();
  if (/just now|minutes? ago|few hours/.test(text)) return now.toISOString();
  if (/today/.test(text)) return localDate(now);
  const match = text.match(/(\d+)\+?\s*(day|week|month)/);
  if (!match) return null;
  const days = Number(match[1]) * { day: 1, week: 7, month: 30 }[match[2] as 'day' | 'week' | 'month'];
  return localDate(new Date(now.getTime() - days * DAY_MS));
}

// Naukri prefixes the location label with the work mode ("Hybrid - Bengaluru", "Remote");
// a plain city list means work from office.
export function workModeFromLocation(label: string | null): WorkMode | null {
  if (!label) return null;
  if (/\b(remote|work from home|wfh)\b/i.test(label)) return 'Remote';
  if (/^\s*hybrid\b/i.test(label)) return 'Hybrid';
  return 'Office';
}

const LOCATION_ALIASES: Record<string, string> = {
  bengaluru: 'Bangalore',
  'bangalore rural': 'Bangalore',
  'bengaluru rural': 'Bangalore',
  gurgaon: 'Gurugram',
  'new delhi': 'Delhi',
  'delhi/ncr': 'Delhi NCR',
  'delhi ncr': 'Delhi NCR',
  ncr: 'Delhi NCR',
  bombay: 'Mumbai',
  madras: 'Chennai',
  calcutta: 'Kolkata',
  'work from home': 'Remote',
  wfh: 'Remote',
};

export function canonicalLocation(name: string): string {
  const key = name
    .toLowerCase()
    // "Mumbai (All Areas)", "Noida(Sector 63)"
    .replace(/\([^)]*\)/g, '')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  return LOCATION_ALIASES[key] ?? key.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// "Hybrid - Hyderabad, Chennai, Bengaluru" -> ["Hyderabad", "Chennai", "Bangalore"]
export function splitLocations(label: string | null): string[] {
  if (!label) return [];
  return label
    .replace(/^\s*(hybrid|remote|temp\.?\s*wfh)\s*-\s*/i, '')
    .split(',')
    .map(canonicalLocation)
    .filter(Boolean);
}

export function canonicalJobUrl(url: string): string {
  const parsed = new URL(url, NAUKRI_URLS.base);
  return `https://${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
}

// Naukri job URLs end in the job ID: /job-listings-react-developer-infosys-...-190826037194
export function jobIdFromUrl(url: string): string | null {
  return new URL(url, NAUKRI_URLS.base).pathname.match(/-(\d{8,})\/?$/)?.[1] ?? null;
}

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();

const LEGAL_SUFFIXES = /\b(private|pvt|limited|ltd|llp|inc|incorporated|corp|corporation|co)\b/g;

// Catches the same posting listed under a different ID or URL.
export function dedupeKey(job: { company: string; title: string; location: string | null }): string {
  const company = normalizeText(job.company).replace(LEGAL_SUFFIXES, '').replace(/\s+/g, ' ').trim();
  const locations = splitLocations(job.location)
    .map((l) => l.toLowerCase())
    .sort()
    .join(',');
  return `${company}|${normalizeText(job.title)}|${locations}`;
}

export function normalizeCard(raw: RawCard, now = new Date()): JobCard | null {
  const title = clean(raw.title);
  const company = clean(raw.company);
  const rawUrl = clean(raw.url);
  if (!title || !company || !rawUrl) return null;

  let url: string;
  try {
    url = canonicalJobUrl(rawUrl);
  } catch {
    return null;
  }

  const location = clean(raw.location);
  const experience = clean(raw.experience);
  const salary = clean(raw.salary);
  const years = parseExperience(experience);
  const pay = parseSalaryLakhs(salary);

  return {
    externalId: clean(raw.externalId) ?? jobIdFromUrl(url),
    url,
    dedupeKey: dedupeKey({ company, title, location }),
    title,
    company,
    location,
    workMode: workModeFromLocation(location),
    experience,
    experienceMin: years?.min ?? null,
    experienceMax: years?.max ?? null,
    salary,
    salaryMinLakhs: pay?.min ?? null,
    salaryMaxLakhs: pay?.max ?? null,
    postedAt: parsePostedDate(raw.posted, now),
    skills: [...new Set((raw.skills ?? []).map((s) => s.trim()).filter(Boolean))],
    externalApply: raw.externalApply ?? null,
  };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Job descriptions arrive as HTML; keep paragraph and list structure for the AI prompt later.
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\/\s*(p|div|ul|ol|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith('#')) {
        return String.fromCodePoint(/^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
      }
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
