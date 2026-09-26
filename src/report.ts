import { OUTCOME_LABELS, type ApplicationRow, type Outcome, type Run } from './domain.ts';

const RULE = '='.repeat(50);
const THIN = '-'.repeat(50);

export const OUTCOME_SYMBOLS: Record<Outcome, string> = {
  applied: '✓',
  already_applied: '✓',
  review: '!',
  ready: '○',
  failed: '✗',
  external: '→',
  applying: '…',
};

const row = (label: string, value: number) => `${label.padEnd(26)}${String(value).padStart(5)}`;

// The end-of-run summary printed by `npm run apply` and `npm run report`. Every number comes from
// what this run recorded.
export function formatRunReport(run: Run, applications: ApplicationRow[]): string {
  const heading = { RUNNING: 'IN PROGRESS', PAUSED: 'PAUSED', COMPLETED: 'COMPLETED', STOPPED: 'STOPPED', FAILED: 'FAILED' }[run.status];
  const lines = [
    RULE,
    `AUTO APPLY RUN ${heading}`,
    RULE,
    '',
    `Run ID: ${run.id}`,
    ...(run.stopReason ? [`Reason: ${run.stopReason}`] : []),
    '',
    ...(run.stats.found !== undefined ? [row('Found by the search', run.stats.found), row('New', run.stats.new ?? 0)] : []),
    ...(run.stats.relevant !== undefined ? [row('Relevant', run.stats.relevant), row('Eligible', run.stats.eligible ?? 0)] : []),
    row('Queued', run.stats.queued ?? 0),
    row('Attempted', run.attempted),
    ...(['applied', 'failed', 'external', 'review', 'already_applied', 'ready', 'applying'] as const)
      .filter((outcome) => run.outcomes[outcome] || outcome === 'applied' || outcome === 'failed')
      .map((outcome) => row(OUTCOME_LABELS[outcome], run.outcomes[outcome])),
  ];

  const ordered = [...applications].sort((a, b) => a.id - b.id);
  const section = (title: string, items: ApplicationRow[], describe: (a: ApplicationRow) => string[]) => {
    if (!items.length) return;
    lines.push('', THIN, title, THIN);
    for (const item of items) lines.push('', `${OUTCOME_SYMBOLS[item.outcome]} ${item.company}`, `  ${item.jobTitle}`, ...describe(item).map((l) => `  ${l}`));
  };
  section('APPLIED', ordered.filter((a) => a.outcome === 'applied'), (a) => [`Score: ${a.matchScore ?? '-'}`]);
  section('NOT APPLIED', ordered.filter((a) => a.outcome !== 'applied'), (a) => [
    `${a.status}${a.failureCode && a.failureCode !== a.status ? ` (${a.failureCode})` : ''}`,
    ...(a.failureReason ? [`Reason: ${a.failureReason}`] : []),
    ...(a.question ? [`Question: "${a.question}"`] : []),
  ]);
  lines.push('', RULE);
  return lines.join('\n');
}
