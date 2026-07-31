/**
 * Lightweight name matcher for the search feature — both resolving `from:` /
 * `in:` operators to ids and ranking the instant name tier. This is NOT a full
 * fuzzy library (the web uses a richer scorer in `frontend/src/lib/fuzzy.ts`);
 * exact / prefix / word-prefix / substring / initials tiers are enough to map a
 * typed name to a channel/person/agent and to order the instant results.
 *
 * Higher is better; 0 means "no match". The tiers are spaced so callers can
 * threshold (operator resolution requires >= `RESOLVE_MIN`) and so a stronger
 * match always outranks a weaker one regardless of candidate length.
 */
export function nameMatchScore(query: string, text: string | null | undefined): number {
  if (!text) return 0;
  const q = query.trim().toLowerCase();
  const t = text.trim().toLowerCase();
  if (!q || !t) return 0;

  if (t === q) return 1000;
  if (t.startsWith(q)) return 850;

  const words = t.split(/[\s\-_]+/u).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 750;
  if (t.includes(q)) return 650;

  // Initials, e.g. "John Doe" → "jd".
  const initials = words.map((w) => w[0] ?? '').join('');
  if (initials.length > 1 && initials.startsWith(q)) return 550;

  return 0;
}

/** Minimum score for `nameMatchScore` to count as a resolved operator name. */
export const RESOLVE_MIN = 500;
