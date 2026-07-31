/**
 * Dependency-free fuzzy matcher for the command palette's Tier-1 name search
 * (channels, DMs, people, agents). Small and synchronous — the workspace's
 * name set is held in memory, so this runs well under a frame. See
 * docs/protocol/SEARCH_SPEC.md (Tier 1).
 *
 * Returns a non-negative score (higher = better) for a match, or -1 for no
 * match. The tiers, best-first:
 *   exact > prefix > word-boundary prefix > substring > initials > subsequence
 * Shorter candidates win ties (a query is "more of" a short name). Multi-token
 * queries are order-insensitive: every token must match somewhere, so
 * "design team" matches both "#design-team" and "#team-design".
 */

const WORD_SPLIT = /[\s\-_/.@#]+/;

/** Greatest score of any single contiguous run when matching `q` as a
 *  subsequence of `t`, or -1 if `q` is not a subsequence at all. Rewards
 *  contiguous matches (fewer, longer runs) over scattered ones. */
function subsequenceScore(q: string, t: string): number {
  let ti = 0;
  let runs = 0;
  let inRun = false;
  for (const ch of q) {
    let found = false;
    while (ti < t.length) {
      if (t[ti] === ch) {
        if (!inRun) {
          runs++;
          inRun = true;
        }
        ti++;
        found = true;
        break;
      }
      inRun = false;
      ti++;
    }
    if (!found) return -1;
  }
  // Fewer runs = more contiguous = better. Normalise so a single run scores
  // highest and never goes negative.
  return Math.max(0, q.length - (runs - 1) * 2);
}

/** Score a single (already-lowercased) token against a candidate. */
function scoreToken(q: string, t: string): number {
  if (!q) return 0;
  if (t === q) return 1000;

  const idx = t.indexOf(q);
  if (idx === 0) return 900 - t.length * 0.1;
  if (idx > 0) {
    const onBoundary = WORD_SPLIT.test(t[idx - 1] ?? "");
    return (onBoundary ? 800 : 500) - idx - t.length * 0.1;
  }

  const initials = t.split(WORD_SPLIT).filter(Boolean).map((w) => w[0] ?? "").join("");
  if (initials.includes(q)) return 600 - t.length * 0.1;

  const sub = subsequenceScore(q, t);
  if (sub >= 0) return 300 + sub - t.length * 0.1;

  return -1;
}

/**
 * Score `query` against `text`. Returns -1 for no match. For multi-token
 * queries, every token must match (order-insensitive); the result is the sum
 * of per-token scores.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();

  const tokens = q.split(WORD_SPLIT).filter(Boolean);
  if (tokens.length <= 1) return scoreToken(q, t);

  let total = 0;
  for (const tok of tokens) {
    const s = scoreToken(tok, t);
    if (s < 0) return -1; // every token must match somewhere
    total += s;
  }
  return total;
}

/**
 * Best score of `query` across several candidate strings (e.g. a person's
 * display name and email), so a hit on any of them counts. -1 if none match.
 */
export function fuzzyScoreAny(query: string, texts: (string | null | undefined)[]): number {
  let best = -1;
  for (const text of texts) {
    if (!text) continue;
    const s = fuzzyScore(query, text);
    if (s > best) best = s;
  }
  return best;
}
