'use client';

import type { ProfileResponse, SavedAnswer, UserProfile } from '@bot/domain';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, ErrorText, Panel, StatusBadge } from '@/components/ui';
import { post } from '@/lib/api';
import { useSettings } from '@/lib/scope';

const COMMON_QUESTIONS = ['relocate', 'authorized to work', 'preferred location', 'work from office'];

interface Form {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  preferredLocations: string;
  experienceYears: string;
  experienceToleranceMonths: string;
  currentRole: string;
  currentCompany: string;
  noticePeriodDays: string;
  currentSalary: string;
  expectedSalary: string;
  skills: string;
  otherSkills: string;
}

const EMPTY: Form = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  location: '',
  preferredLocations: '',
  experienceYears: '',
  experienceToleranceMonths: '6',
  currentRole: '',
  currentCompany: '',
  noticePeriodDays: '',
  currentSalary: '',
  expectedSalary: '',
  skills: '',
  otherSkills: '',
};

const list = (text: string) => text.split(',').map((item) => item.trim()).filter(Boolean);

function toForm(p: UserProfile): Form {
  return {
    ...p,
    preferredLocations: p.preferredLocations.join(', '),
    experienceYears: String(p.experienceYears),
    experienceToleranceMonths: String(p.experienceToleranceMonths),
    noticePeriodDays: p.noticePeriodDays === null ? '' : String(p.noticePeriodDays),
    skills: p.skills.join(', '),
    otherSkills: p.otherSkills.join(', '),
  };
}

function toProfile(form: Form, previous: UserProfile | null, resumeFile: string | null): Record<string, unknown> {
  const skills = list(form.skills);
  const otherSkills = list(form.otherSkills);
  const own = new Set([...skills, ...otherSkills].map((s) => s.toLowerCase()));
  // Aliases can only be edited in the file; ones for a skill that was removed are dropped.
  const skillAliases = Object.fromEntries(Object.entries(previous?.skillAliases ?? {}).filter(([skill]) => own.has(skill.toLowerCase())));
  return {
    ...form,
    preferredLocations: list(form.preferredLocations),
    experienceYears: form.experienceYears === '' ? null : Number(form.experienceYears),
    experienceToleranceMonths: Number(form.experienceToleranceMonths || 0),
    noticePeriodDays: form.noticePeriodDays === '' ? null : Number(form.noticePeriodDays),
    skills,
    otherSkills,
    skillAliases,
    resumeFile,
  };
}

const answerRows = (answers: SavedAnswer[]) =>
  answers.length ? answers.map((a) => ({ match: a.match.join(', '), answer: a.answer })) : COMMON_QUESTIONS.map((match) => ({ match, answer: '' }));

const input = 'w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex flex-col gap-1">
        <span className="font-medium text-slate-700">{label}</span>
        {children}
      </label>
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </div>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

// Everything the bot needs to fill applications. Saved only in data/ on this machine.
export default function ProfilePage() {
  const { profile: loaded, reloadProfile } = useSettings();
  const [form, setForm] = useState<Form>(EMPTY);
  const [answers, setAnswers] = useState(answerRows([]));
  const [resumeFile, setResumeFile] = useState<string | null>(null);
  const [status, setStatus] = useState<{ error?: string; saved?: boolean; uploading?: boolean }>({});
  const [filled, setFilled] = useState(false);

  useEffect(() => {
    if (!loaded || filled) return;
    if (loaded.profile) setForm(toForm(loaded.profile));
    setAnswers(answerRows(loaded.answers));
    setResumeFile(loaded.profile?.resumeFile ?? null);
    setFilled(true);
  }, [loaded, filled]);

  const set = (key: keyof Form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [key]: e.target.value });
    setStatus({});
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setStatus({ uploading: true });
    try {
      const { file: saved } = await post<{ file: string }>('/api/profile/resume', { name: file.name, data: await readBase64(file) });
      setResumeFile(saved);
      reloadProfile();
      setStatus({});
    } catch (err) {
      setStatus({ error: (err as Error).message });
    }
  };

  const save = async () => {
    const saved = answers
      .map((row) => ({ match: list(row.match), answer: row.answer.trim() }))
      .filter((row) => row.match.length && row.answer);
    try {
      await post<ProfileResponse>('/api/profile', { profile: toProfile(form, loaded?.profile ?? null, resumeFile), answers: saved });
      reloadProfile();
      setStatus({ saved: true });
    } catch (err) {
      setStatus({ error: (err as Error).message });
    }
  };

  return (
    <div className="space-y-4">
      <Panel title="Profile" actions={loaded?.ready ? <StatusBadge status="PROFILE_READY" /> : undefined}>
        <div className="space-y-6">
          <p className="text-sm text-slate-600">
            Used to fill applications. Stored only on this computer, in <code>data/user-profile.json</code>, which git ignores.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="First name *">
              <input className={input} value={form.firstName} onChange={set('firstName')} autoComplete="given-name" />
            </Field>
            <Field label="Last name">
              <input className={input} value={form.lastName} onChange={set('lastName')} autoComplete="family-name" />
            </Field>
            <Field label="Email">
              <input className={input} type="email" value={form.email} onChange={set('email')} autoComplete="email" />
            </Field>
            <Field label="Phone">
              <input className={input} type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" />
            </Field>
            <Field label="Current location">
              <input className={input} value={form.location} onChange={set('location')} placeholder="City" />
            </Field>
            <Field label="Preferred locations" hint="Comma-separated; the default locations to search">
              <input className={input} value={form.preferredLocations} onChange={set('preferredLocations')} placeholder="Remote, Bangalore" />
            </Field>
            <Field label="Years of experience *">
              <input className={input} type="number" min={0} max={60} step={0.5} value={form.experienceYears} onChange={set('experienceYears')} />
            </Field>
            <Field label="Experience tolerance (months)" hint="Jobs asking for up to this much more are still applied to">
              <input className={input} type="number" min={0} max={60} value={form.experienceToleranceMonths} onChange={set('experienceToleranceMonths')} />
            </Field>
            <Field label="Notice period (days)">
              <input className={input} type="number" min={0} max={365} value={form.noticePeriodDays} onChange={set('noticePeriodDays')} />
            </Field>
            <Field label="Current role">
              <input className={input} value={form.currentRole} onChange={set('currentRole')} />
            </Field>
            <Field label="Current company">
              <input className={input} value={form.currentCompany} onChange={set('currentCompany')} />
            </Field>
            <Field label="Current salary (CTC)">
              <input className={input} value={form.currentSalary} onChange={set('currentSalary')} />
            </Field>
            <Field label="Expected salary (CTC)">
              <input className={input} value={form.expectedSalary} onChange={set('expectedSalary')} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Skills *" hint="Comma-separated; your main skills">
              <textarea className={input} rows={2} value={form.skills} onChange={set('skills')} />
            </Field>
            <Field label="Other skills" hint="Comma-separated">
              <textarea className={input} rows={2} value={form.otherSkills} onChange={set('otherSkills')} />
            </Field>
          </div>

          <div className="space-y-2 text-sm">
            <p className="font-medium text-slate-700">Resume</p>
            <p className="text-slate-600">
              {loaded?.resume && (!resumeFile || loaded.resume.name === resumeFile)
                ? `${loaded.resume.name} (${Math.round(loaded.resume.size / 1024)} KB)`
                : (resumeFile ?? 'None uploaded')}
            </p>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded bg-white px-3 py-1.5 font-medium text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
              {resumeFile ? 'Replace resume' : 'Upload resume'}
              <input type="file" accept=".pdf,.doc,.docx" className="sr-only" onChange={(e) => upload(e.target.files?.[0])} />
            </label>
            {status.uploading && <span className="ml-2 text-slate-500">Uploading…</span>}
            <p className="text-xs text-slate-500">PDF or Word, up to 5 MB. Stored in data/resume/.</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">Application answers</p>
            <p className="text-xs text-slate-500">
              A recruiter question is answered when it contains every phrase on the left (comma-separated). Name, contact details, experience, notice period, role,
              company and salary come from the fields above. Any other required question sends the job to Review; nothing is guessed.
            </p>
            {answers.map((row, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input
                  className={input}
                  aria-label="Question contains"
                  placeholder="Question contains"
                  value={row.match}
                  onChange={(e) => setAnswers(answers.map((r, i) => (i === index ? { ...r, match: e.target.value } : r)))}
                />
                <input
                  className={input}
                  aria-label="Answer"
                  placeholder="Answer"
                  value={row.answer}
                  onChange={(e) => setAnswers(answers.map((r, i) => (i === index ? { ...r, answer: e.target.value } : r)))}
                />
                <Button onClick={() => setAnswers(answers.filter((_, i) => i !== index))}>Remove</Button>
              </div>
            ))}
            <Button onClick={() => setAnswers([...answers, { match: '', answer: '' }])}>Add answer</Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" className="px-5 py-2" onClick={save}>
              Save profile
            </Button>
            {status.saved && <StatusBadge status="PROFILE_READY" />}
          </div>
          <ErrorText>{status.error}</ErrorText>
          {loaded?.problems.length ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-amber-900">
              {loaded.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
