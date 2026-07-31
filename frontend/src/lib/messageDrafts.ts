/**
 * Per-channel composer drafts, persisted to localStorage on this device.
 *
 * Follows the Telegram/WhatsApp model: every chat keeps its own unsent
 * draft (text + reply context + agent target). Switching chats, reloading,
 * or relaunching the app restores it; sending — or deleting the text —
 * removes it. Drafts are namespaced per signed-in user so a shared device
 * never surfaces one account's unsent text under another.
 *
 * Architecture: the in-memory map is the source of truth and is updated
 * synchronously on every change (so a fast channel switch can never lose
 * the tail of a draft); the JSON → localStorage write and the subscriber
 * notification are debounced behind ``PERSIST_DEBOUNCE_MS``. ``flush()``
 * forces both — called on channel switch, tab hide, and page unload.
 * Cross-tab edits arrive via the ``storage`` event and merge per channel
 * by ``updatedAt`` (newer wins).
 */
import type { MmChannelPost } from "@/lib/api";

export interface MessageDraft {
  text: string;
  /** Slimmed snapshot of the post being replied to — enough to rebuild the
   *  reply strip and ``parent_post_id`` on send. Bulky fields (reactions,
   *  files, previews) are stripped before storage. */
  reply: MmChannelPost | null;
  /** Manual agent-target chip selection, restored alongside the text. */
  targetAgentId: string | null;
  updatedAt: number;
}

export interface DraftInput {
  text: string;
  reply: MmChannelPost | null;
  targetAgentId: string | null;
}

const PERSIST_DEBOUNCE_MS = 400;
/** Hard cap on stored drafts; the oldest beyond this are pruned on write. */
const MAX_ENTRIES = 50;
/** Mirrors the composer's MAX_LEN — anything longer is foreign data. */
const MAX_TEXT_LEN = 4000;
/** Reply snapshots only feed a one-line strip; keep them small. */
const MAX_REPLY_EXCERPT_LEN = 500;

function storageKey(userId: number): string {
  return `fc_message_drafts_${String(userId)}`;
}

function slimReply(reply: MmChannelPost | null): MmChannelPost | null {
  if (!reply) return null;
  return {
    ...reply,
    message: (reply.message || "").slice(0, MAX_REPLY_EXCERPT_LEN),
    reactions: [],
    files: [],
    link_preview: null,
    parent_preview: null,
  };
}

/** Defensive parse — bad JSON, foreign shapes, or oversized fields from a
 *  previous app version all degrade to "no draft" rather than throwing. */
function parseStored(raw: string | null): Map<string, MessageDraft> {
  const out = new Map<string, MessageDraft>();
  if (!raw) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof data !== "object" || data == null || Array.isArray(data)) return out;
  for (const [channelId, value] of Object.entries(data)) {
    if (typeof value !== "object" || value == null) continue;
    const v = value as Partial<MessageDraft>;
    if (typeof v.text !== "string") continue;
    const text = v.text.slice(0, MAX_TEXT_LEN);
    const rawReply = v.reply;
    const reply =
      rawReply != null &&
      typeof rawReply === "object" &&
      typeof rawReply.post_id === "number" &&
      typeof rawReply.message === "string"
        ? rawReply
        : null;
    if (text.trim().length === 0 && reply == null) continue;
    out.set(channelId, {
      text,
      reply,
      targetAgentId: typeof v.targetAgentId === "string" ? v.targetAgentId : null,
      updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : Date.now(),
    });
  }
  return out;
}

export class DraftStore {
  private userId: number | null = null;
  private cache = new Map<string, MessageDraft>();
  /** Stable-identity copy handed to useSyncExternalStore subscribers —
   *  rebuilt only on flush/load/merge, NOT per keystroke, so the sidebar
   *  doesn't re-render on every character. */
  private snapshot: ReadonlyMap<string, MessageDraft> = new Map();
  private readonly listeners = new Set<() => void>();
  private writeTimer: number | null = null;
  private dirty = false;

  constructor() {
    if (typeof window === "undefined") return;
    window.addEventListener("storage", (e) => {
      this.handleStorageEvent(e);
    });
    // Durability backstops: a backgrounded or closing tab may never get
    // another debounce tick, so force the pending write out.
    window.addEventListener("pagehide", () => {
      this.flush();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flush();
    });
  }

  /** Bind the store to the signed-in user; reloads on account switch. */
  private ensure(userId: number): void {
    if (this.userId === userId) return;
    this.flush(); // persist pending edits under the old namespace first
    this.userId = userId;
    this.cache = this.readFromStorage();
    this.dirty = false;
    this.snapshot = new Map(this.cache);
    this.notify();
  }

  get(userId: number, channelId: string): MessageDraft | null {
    this.ensure(userId);
    return this.cache.get(channelId) ?? null;
  }

  /** Record the live composer state for a channel. Empty text with no
   *  reply deletes the entry (a sent or cleared message leaves no draft).
   *  The in-memory map updates synchronously; persistence is debounced. */
  set(userId: number, channelId: string, value: DraftInput): void {
    this.ensure(userId);
    const prev = this.cache.get(channelId);
    const text = value.text.slice(0, MAX_TEXT_LEN);
    const meaningful = text.trim().length > 0 || value.reply != null;
    if (!meaningful) {
      if (!prev) return;
      this.cache.delete(channelId);
      this.scheduleWrite();
      return;
    }
    if (prev) {
      const unchanged =
        prev.text === text &&
        (prev.reply?.post_id ?? null) === (value.reply?.post_id ?? null) &&
        prev.targetAgentId === value.targetAgentId;
      if (unchanged) return;
    }
    this.cache.set(channelId, {
      text,
      reply: slimReply(value.reply),
      targetAgentId: value.targetAgentId,
      updatedAt: Date.now(),
    });
    this.scheduleWrite();
  }

  clear(userId: number, channelId: string): void {
    this.set(userId, channelId, { text: "", reply: null, targetAgentId: null });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (userId: number): ReadonlyMap<string, MessageDraft> => {
    this.ensure(userId);
    return this.snapshot;
  };

  /** Run the debounced write + notification now. Safe to call any time. */
  flush(): void {
    if (this.writeTimer != null) {
      window.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.dirty || this.userId == null) return;
    this.dirty = false;
    this.prune(MAX_ENTRIES);
    this.writeToStorage();
    this.snapshot = new Map(this.cache);
    this.notify();
  }

  private scheduleWrite(): void {
    this.dirty = true;
    if (this.writeTimer != null) return; // trailing throttle while typing
    this.writeTimer = window.setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, PERSIST_DEBOUNCE_MS);
  }

  private prune(limit: number): void {
    if (this.cache.size <= limit) return;
    const byRecency = [...this.cache.entries()].sort(
      (a, b) => b[1].updatedAt - a[1].updatedAt,
    );
    this.cache = new Map(byRecency.slice(0, limit));
  }

  private readFromStorage(): Map<string, MessageDraft> {
    if (this.userId == null) return new Map();
    try {
      return parseStored(localStorage.getItem(storageKey(this.userId)));
    } catch {
      return new Map(); // privacy mode / storage disabled
    }
  }

  private writeToStorage(): void {
    if (this.userId == null) return;
    const key = storageKey(this.userId);
    try {
      if (this.cache.size === 0) {
        localStorage.removeItem(key);
        return;
      }
      localStorage.setItem(key, JSON.stringify(Object.fromEntries(this.cache)));
    } catch {
      // Quota exceeded — drop the oldest half and retry once; on a second
      // failure the drafts simply stay in-memory for this session.
      try {
        this.prune(Math.max(1, Math.floor(this.cache.size / 2)));
        localStorage.setItem(key, JSON.stringify(Object.fromEntries(this.cache)));
      } catch {
        /* noop */
      }
    }
  }

  /** Another tab wrote our key. Adopt its map; when we hold unflushed
   *  local edits, keep whichever side of each conflict is newer. The rare
   *  lose-case (same channel typed in two tabs at once) resolves as
   *  last-writer-wins, same as Slack/Discord web. */
  private handleStorageEvent(e: StorageEvent): void {
    if (this.userId == null || e.key !== storageKey(this.userId)) return;
    const incoming = parseStored(e.newValue);
    if (this.dirty) {
      for (const [channelId, ours] of this.cache) {
        const theirs = incoming.get(channelId);
        if (!theirs || theirs.updatedAt < ours.updatedAt) {
          incoming.set(channelId, ours);
        }
      }
    }
    this.cache = incoming;
    this.snapshot = new Map(this.cache);
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const draftStore = new DraftStore();
