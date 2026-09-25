import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './config.ts';

const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = Exclude<keyof typeof levels, 'silent'>;

let logDirReady = false;

function write(level: Level, message: string, err?: unknown): void {
  // Read on every call because .env is loaded after this module is imported.
  const threshold = levels[process.env.LOG_LEVEL as keyof typeof levels] ?? levels.info;
  if (levels[level] < threshold) return;

  const now = new Date();
  const detail = err === undefined ? '' : err instanceof Error ? err.message : String(err);
  const line = detail ? `${message}: ${detail}` : message;
  const label = level === 'warn' || level === 'error' ? `${level.toUpperCase()} ` : '';
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(`[${now.toTimeString().slice(0, 8)}] ${label}${line}\n`);

  const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';
  try {
    if (!logDirReady) {
      mkdirSync(paths.logs, { recursive: true });
      logDirReady = true;
    }
    const file = join(paths.logs, `${now.toLocaleDateString('en-CA')}.log`);
    appendFileSync(file, `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${line}${stack}\n`);
  } catch {
    // A full disk or unwritable logs/ must not abort a browser run that is otherwise fine.
  }
}

export const log = {
  debug: (message: string) => write('debug', message),
  info: (message: string) => write('info', message),
  warn: (message: string, err?: unknown) => write('warn', message, err),
  error: (message: string, err?: unknown) => write('error', message, err),
};
