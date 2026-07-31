// Reconstruct an agent's full reasoning from the rolling TAILS the live-activity
// plane streams. The plugin sanitizes live thinking to a short tail (for text
// over its cap: ``…`` + the last ~139 chars, cut at a word boundary), so a
// naive "keep the latest tail" only ever shows the end of a thought. But
// successive tails of one burst are each a suffix of the same growing text, so
// they OVERLAP — and welding each new tail onto the previous along that overlap
// rebuilds most of the thought. Purely client-side; the plugin is unchanged.

// Reconstruction cap for a single reasoning segment — bounds memory for a
// pathologically long burst; the newest text wins if it's ever exceeded.
export const THINKING_ACC_MAX_CHARS = 8000;

/**
 * Weld a freshly-arrived thinking TAIL (``rawTail``) onto the text reconstructed
 * so far for the current burst (``acc``).
 *
 * - First tail (``acc`` empty) seeds the text verbatim; a leading ``…`` there
 *   honestly marks a burst we joined mid-stream and can't fully recover.
 * - A later tail whose start still lies within ``acc`` extends it along the
 *   overlap; one already fully contained is a no-op.
 * - If the burst grew by more than a tail's width between two ~1/s ticks, the
 *   new tail starts past ``acc`` (no overlap) — append it behind a ``…`` gap
 *   marker rather than silently dropping the skipped reasoning.
 */
export function stitchThinkingTail(acc: string, rawTail: string): string {
  const incoming = rawTail.trim();
  if (!acc) return incoming;
  // Drop the plugin's leading "…" marker on continuation tails — the context it
  // stands for is already present in ``acc``.
  const tail = incoming.replace(/^…+\s*/u, "");
  if (!tail || acc.includes(tail)) return acc;
  // Largest suffix of ``acc`` that is a prefix of ``tail`` is their overlap.
  let overlap = 0;
  for (let k = Math.min(acc.length, tail.length); k > 0; k--) {
    if (acc.endsWith(tail.slice(0, k))) {
      overlap = k;
      break;
    }
  }
  const merged = overlap > 0 ? acc + tail.slice(overlap) : `${acc} … ${tail}`;
  return merged.length > THINKING_ACC_MAX_CHARS
    ? `…${merged.slice(-THINKING_ACC_MAX_CHARS)}`
    : merged;
}
