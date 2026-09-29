import { useCallback, useSyncExternalStore } from "react";
import { randomGeneratingWord } from "@/lib/generatingWords";

/**
 * One rotation per agent, shared by the presence row and the streaming draft, which render separate lines for the same
 * turn: a per-line rotation would reset the word, and its timing, when the draft lands. The interval backs off from
 * 7s toward 30s, since a word changing every few seconds reads as churn. An entry outlives its last subscriber by a
 * grace window, which spans the commit where one line unmounts before the next mounts.
 */
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
 * Rotating gerund shared by every line showing an agent's live turn, so the
 * presence row and the streaming draft stay in lockstep. Empty without an
 * agent: a finished turn's line keeps no rotation running.
 */
export function useAgentGeneratingWord(agentId: string | undefined): string {
  const subscribe = useCallback(
    (onChange: () => void) => (agentId ? subscribeAgentWord(agentId, onChange) : () => undefined),
    [agentId],
  );
  const getSnapshot = useCallback(() => (agentId ? getOrCreateWordEntry(agentId).word : ""), [agentId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
