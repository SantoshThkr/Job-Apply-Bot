// Blocks commits that would publish secrets or private files.
// `node scripts/scan-secrets.ts` checks everything git would commit; `--staged` checks the index (pre-commit hook).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface Finding {
  path: string;
  line?: number;
  reason: string;
  severity: 'block' | 'warn';
}

// Files that must stay local whatever they contain.
const PRIVATE_PATHS: [RegExp, string][] = [
  [/(^|\/)\.env(\.(?!example$)[^/]+)?$/, 'environment file'],
  [/^data\/(?![^/]*\.example\.json$)/, 'local data (profile, resume, browser profile, database)'],
  [/(^|\/)(user-profile|answers)\.json$/, 'personal profile or answers'],
  [/^config\/(?![^/]*\.example\.json$)[^/]*\.json$/, 'personal config'],
  [/^resume\/(?!README\.md$)/, 'resume folder'],
  [/\.(pdf|docx?)$/i, 'document (resume?)'],
  [/\.(db|sqlite3?)$/i, 'database'],
  [/(^|\/)(logs|debug|screenshots|traces|test-results|playwright-report)\//, 'debug artifact'],
  [/(storage-?state[^/]*\.json|\.har|\.zip)$/i, 'browser session export or trace'],
];

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/, 'OpenAI API key'],
  [/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*['"]?[^\s'"#]+/, 'OPENAI_API_KEY with a value'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, 'bearer token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bnauk_[a-z]+\s*[=:]\s*['"]?[A-Za-z0-9._-]{16,}/, 'Naukri session cookie'],
  [/\bpass(?:word|wd)?\s*[=:]\s*['"][^'"\s]{4,}['"]/i, 'hard-coded password'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
];

// Worth a look but legitimate often enough that they only warn.
const PERSONAL_PATTERNS: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, 'email address'],
  [/(?<![\w+/.-])(?:\+91[\s-]?)?[6-9]\d{9}(?!\w)/, 'phone number'],
];

export function privatePathReason(path: string): string | undefined {
  return PRIVATE_PATHS.find(([pattern]) => pattern.test(path))?.[1];
}

export function scanContent(path: string, content: string): Finding[] {
  const findings: Finding[] = [];
  content.split('\n').forEach((text, index) => {
    for (const [pattern, reason] of SECRET_PATTERNS) {
      if (pattern.test(text)) findings.push({ path, line: index + 1, reason, severity: 'block' });
    }
    for (const [pattern, reason] of PERSONAL_PATTERNS) {
      if (pattern.test(text)) findings.push({ path, line: index + 1, reason, severity: 'warn' });
    }
  });
  return findings;
}

function git(args: string[]): Buffer {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
}

function scanRepository(staged: boolean): { files: number; findings: Finding[] } {
  const listArgs = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  const paths = git(listArgs).toString().split('\0').filter(Boolean);

  const findings: Finding[] = [];
  for (const path of paths) {
    const reason = privatePathReason(path);
    if (reason) {
      findings.push({ path, reason, severity: 'block' });
      continue;
    }
    let content: Buffer;
    try {
      content = staged ? git(['show', `:${path}`]) : readFileSync(path);
    } catch {
      continue; // tracked but deleted from the working tree
    }
    if (content.subarray(0, 8000).includes(0)) continue; // binary
    findings.push(...scanContent(path, content.toString('utf8')));
  }
  return { files: paths.length, findings };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const staged = process.argv.includes('--staged');
  const { files, findings } = scanRepository(staged);
  for (const f of findings) {
    const where = f.line ? `${f.path}:${f.line}` : f.path;
    console.log(`${f.severity === 'block' ? 'BLOCKED' : 'warning'}  ${where}  ${f.reason}`);
  }

  const blocked = findings.filter((f) => f.severity === 'block').length;
  if (blocked) {
    console.error(
      `\nSecret scan: ${blocked} problem(s) in ${files} ${staged ? 'staged ' : ''}file(s). ` +
        'Unstage or remove them. If a real credential was ever committed, revoke and rotate it.',
    );
    process.exit(1);
  }
  console.log(`Secret scan: ${files} ${staged ? 'staged ' : ''}file(s) checked, nothing blocked.`);
}
