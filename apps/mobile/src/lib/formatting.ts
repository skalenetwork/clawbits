import { type HumanUser } from '@/lib/api';

export function formatChannelTitle(value: string): string {
  return value
    .replace(/^agent-/u, '')
    .replace(/[-_]+/gu, ' ')
    .trim();
}

/** Time-of-day greeting keyed off the local hour, mirroring the web home
 *  (`frontend/src/lib/formatting.ts`). Accepts an injectable date for tests
 *  and so the home screen can snapshot ``now`` once per mount. */
export function getTimeOfDayGreeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Locale-aware long date, e.g. "Tuesday, June 24". Matches the web
 *  home's subline date. */
export function formatLongDate(date = new Date()): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/** Extract a leading first name from the user's display name, falling
 *  back to the email local-part, falling back to "there" so a greeting
 *  never reads as "Good evening, ". Moved here from the home screen so the
 *  hero and the nav title can share it. */
export function pickFirstName(user: HumanUser): string {
  const name = (user.display_name ?? '').trim();
  if (name.length > 0) {
    const first = name.split(/\s+/u)[0];
    if (first && first.length > 0) return first;
  }
  const local = (user.email ?? '').split('@')[0]?.trim() ?? '';
  if (local.length > 0) return local;
  return 'there';
}

export function formatRelativeTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return '';

  const diffSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diffSeconds < 60) return 'now';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
