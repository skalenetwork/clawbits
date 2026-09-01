import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import { randomGeneratingWord } from "@/lib/generatingWords";

/**
 * Returns a playful "generating" gerund that rotates while an agent drafts.
 *
 * The interval BACKS OFF over time: calm from the start, then settling toward a
 * long cadence — a word changing every few seconds reads as churn/anxiety rather
 * than delight, so changes stay deliberately infrequent. Each rotation
 * multiplies the delay by ``BACKOFF`` up to ``MAX_MS``; the t-shimmer sweep and
 * the gentle crossfade between words keep the label visibly alive between
 * changes, so motion never stops even as the rotation calms. Call once per
 * indicator so two on-screen indicators don't tick in lockstep.
 */
export function useGeneratingWord(startMs = 7000): string {
  const [word, setWord] = useState<string>(() => randomGeneratingWord());
  useEffect(() => {
    const MAX_MS = 30_000;
    const BACKOFF = 1.5;
    let handle = 0;
    let delay = startMs;
    const tick = () => {
      setWord((prev) => randomGeneratingWord(prev));
      delay = Math.min(MAX_MS, Math.round(delay * BACKOFF));
      handle = window.setTimeout(tick, delay);
    };
    handle = window.setTimeout(tick, delay);
    return () => { window.clearTimeout(handle); };
  }, [startMs]);
  return word;
}

// ── Per-agent shared rotation ───────────────────────────────────────────────
// The presence-derived GeneratingRow and the streaming DraftBody render SEPARATE
// GeneratingIndicator instances for the same agent. A per-instance rotation
// (above) would reset the word — and its rotation timing — at the
// presence→streaming handoff, so the label visibly jumps the moment the real
// post lands. Keying the rotation by agent id in one module-level store makes
// both instances read the same word driven by a single shared timer, so the
// handoff is seamless. Entries self-clean a few seconds after their last
// subscriber leaves, which spans the one-commit gap where the old instance
// unmounts before the new one mounts.
interface WordEntry {
  word: string;
  delay: number;
  timer: number | null;
  cleanup: number | null;
  subscribers: Set<() => void>;
}
const WORD_START_MS = 7000;
const WORD_MAX_MS = 30_000;
const WORD_BACKOFF = 1.5;
const WORD_GRACE_MS = 5000;
const agentWordStore = new Map<string, WordEntry>();

function getOrCreateWordEntry(key: string): WordEntry {
  let entry = agentWordStore.get(key);
  if (!entry) {
    entry = {
      word: randomGeneratingWord(),
      delay: WORD_START_MS,
      timer: null,
      cleanup: null,
      subscribers: new Set(),
    };
    agentWordStore.set(key, entry);
  }
  return entry;
}
function startWordTimer(key: string, entry: WordEntry): void {
  entry.timer = window.setTimeout(() => {
    entry.word = randomGeneratingWord(entry.word);
    entry.delay = Math.min(WORD_MAX_MS, Math.round(entry.delay * WORD_BACKOFF));
    for (const notify of entry.subscribers) notify();
    startWordTimer(key, entry);
  }, entry.delay);
}
function subscribeAgentWord(key: string, onChange: () => void): () => void {
  const entry = getOrCreateWordEntry(key);
  if (entry.cleanup !== null) { window.clearTimeout(entry.cleanup); entry.cleanup = null; }
  entry.subscribers.add(onChange);
  if (entry.timer === null) startWordTimer(key, entry);
  return () => {
    entry.subscribers.delete(onChange);
    if (entry.subscribers.size > 0) return;
    // Pause rotation and schedule deletion, but keep the current word + backoff
    // so a re-subscribe within the grace window resumes exactly where it left
    // off (the seamless handoff).
    if (entry.timer !== null) { window.clearTimeout(entry.timer); entry.timer = null; }
    entry.cleanup = window.setTimeout(() => { agentWordStore.delete(key); }, WORD_GRACE_MS);
  };
}

/**
 * Rotating gerund shared across every indicator for a given agent. Pass the
 * agent id so the presence row and the streaming draft stay in lockstep; when
 * no id is available a stable per-instance fallback key is used so the hook
 * still behaves like a private {@link useGeneratingWord}.
 */
export function useAgentGeneratingWord(agentId: string | undefined): string {
  const fallbackId = useId();
  const key = agentId ?? `__fallback:${fallbackId}`;
  const subscribe = useCallback((onChange: () => void) => subscribeAgentWord(key, onChange), [key]);
  const getSnapshot = useCallback(() => getOrCreateWordEntry(key).word, [key]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
