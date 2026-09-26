import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { label } from '@/lib/format';

type Tone = 'good' | 'bad' | 'warn' | 'info' | 'muted';

const TONES: Record<Tone, string> = {
  good: 'bg-emerald-50 text-emerald-800 ring-emerald-600/30',
  bad: 'bg-red-50 text-red-800 ring-red-600/30',
  warn: 'bg-amber-50 text-amber-900 ring-amber-600/40',
  info: 'bg-sky-50 text-sky-800 ring-sky-600/30',
  muted: 'bg-slate-100 text-slate-700 ring-slate-500/20',
};

// Symbol plus words for every status, so nothing depends on color alone. Lowercase keys are the
// simple statuses the dashboard shows; uppercase ones are the exact states behind them.
const STATUSES: Record<string, [Tone, string, string?]> = {
  ready: ['info', '○', 'Ready to apply'],
  applying: ['info', '…', 'Applying'],
  applied: ['good', '✓', 'Applied'],
  failed: ['bad', '✗', 'Failed'],
  external: ['muted', '→', 'External'],
  review: ['warn', '!', 'Review'],
  already_applied: ['muted', '✓', 'Already applied'],
  not_eligible: ['muted', '⊘', 'Not eligible'],
  APPLYING: ['info', '…', 'Applying'],
  APPLY_CLICKED: ['info', '…', 'Apply clicked'],
  FORM_OPENED: ['info', '…', 'Form opened'],
  FORM_FILLED: ['info', '…', 'Form filled'],
  SUBMIT_CLICKED: ['info', '…', 'Submitted, checking'],
  READY_TO_APPLY: ['info', '○', 'Ready to apply'],
  READY_TO_SUBMIT: ['info', '○', 'Ready to submit'],
  APPLIED: ['good', '✓', 'Applied'],
  FAILED: ['bad', '✗', 'Failed'],
  EXTERNAL: ['muted', '→', 'External'],
  NEEDS_REVIEW: ['warn', '!', 'Review'],
  ALREADY_APPLIED: ['muted', '✓', 'Already applied'],
  SECURITY_CHALLENGE: ['bad', '⚠', 'Security check'],
  RUNNING: ['info', '●', 'Running'],
  PAUSED: ['warn', '❚❚', 'Paused'],
  COMPLETED: ['good', '✓', 'Completed'],
  STOPPED: ['warn', '■', 'Stopped'],
  LOGGED_IN: ['good', '●', 'Logged in'],
  LOGGED_OUT: ['bad', '●', 'Logged out'],
  CHALLENGE: ['warn', '⚠', 'Security check'],
  BLOCKED: ['bad', '✗', 'Access denied'],
  UNKNOWN: ['muted', '○', 'Not checked'],
  WAITING_FOR_LOGIN: ['info', '…', 'Waiting for login'],
  BROWSER_RUNNING: ['good', '●', 'Ready'],
  BROWSER_STOPPED: ['muted', '○', 'Closed'],
  PROFILE_READY: ['good', '✓', 'Profile ready'],
};

export function StatusBadge({ status }: { status: string }) {
  const [tone, symbol, text] = STATUSES[status] ?? ['muted', '·'];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      <span aria-hidden="true">{symbol}</span>
      {text ?? label(status)}
    </span>
  );
}

export function Panel({ title, actions, children, className = '' }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={`rounded-md border border-slate-200 bg-white ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const VARIANTS = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-300',
  secondary: 'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-700 text-white hover:bg-red-600 disabled:bg-red-200',
};

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return (
    <button
      type="button"
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export function Stat({ label: name, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <dt className="text-xs text-slate-500">{name}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

// ✓ or –, with words for screen readers.
export function Flag({ on, name }: { on: boolean; name: string }) {
  return (
    <span className={on ? 'text-emerald-700' : 'text-slate-400'}>
      <span aria-hidden="true">{on ? '✓' : '–'}</span>
      <span className="sr-only">{on ? `${name}: yes` : `${name}: no`}</span>
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {children}
    </p>
  );
}
