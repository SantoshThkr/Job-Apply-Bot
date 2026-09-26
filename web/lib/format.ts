import type { Freshness } from '@bot/domain';

export function time(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : '-';
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

const DAY = 86_400_000;

// "3h ago" for an exact posting time; "Today" / "2 days ago" when Naukri only gave the date.
export function posted(value: string | null, now = new Date()): string {
  if (!value) return '-';
  if (value.length === 10) {
    const [y, m, d] = value.split('-').map(Number);
    const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(y!, m! - 1, d).getTime()) / DAY);
    return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`;
  }
  const hours = Math.floor((now.getTime() - new Date(value).getTime()) / 3_600_000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export const FRESHNESS_LABELS: Record<Freshness, string> = { today: 'Today', '24h': '24 hours', '3d': '3 days', '7d': '7 days', all: 'All' };

export const label = (value: string) => value.replaceAll('_', ' ');
