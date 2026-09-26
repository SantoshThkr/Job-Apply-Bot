'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLive } from '@/lib/live';

const LINKS = [
  ['/', 'Dashboard'],
  ['/jobs', 'Jobs'],
  ['/apply', 'Apply'],
  ['/history', 'History'],
] as const;

export function Header() {
  const pathname = usePathname();
  const { connected } = useLive();

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
        <Link href="/" className="text-base font-semibold tracking-tight">
          JOB-BOT
        </Link>
        <nav aria-label="Main" className="flex flex-wrap gap-1 text-sm">
          {LINKS.map(([href, text]) => {
            const current = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={current ? 'page' : undefined}
                className={`rounded px-2 py-1 ${current ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              >
                {text}
              </Link>
            );
          })}
        </nav>
        <p className="ml-auto flex items-center gap-1.5 text-xs text-slate-600" aria-live="polite">
          <span aria-hidden="true" className={connected ? 'text-emerald-600' : 'text-red-600'}>
            ●
          </span>
          {connected ? 'Live' : 'Bot server not running (npm run server)'}
        </p>
      </div>
    </header>
  );
}
