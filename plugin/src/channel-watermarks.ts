// Persistent "last seen" watermark per (account, channel).
//
// The inbound poller injects a one-time catch-up backlog the first time the
// agent is tagged in a shared channel. That dedupe lives in memory, so a
// gateway restart would re-inject history the agent has already seen. This
// store records the `create_at` of the newest post the agent has been shown
// per channel and survives restarts, so the post-restart backlog only ever
// carries genuinely new messages.
//
// There is no plugin-SDK key/value surface, so we persist to a small JSON
// file next to the plugin's logs (``process.cwd()``), matching how
// `file-logger` picks its paths. The on-disk shape is:
//
//   { "<accountId>": { "<channelId>": <createAtMs>, ... }, ... }

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Minimal contract the poller depends on. Kept narrow so tests can pass a
 *  pure in-memory implementation (or omit it entirely). */
export interface WatermarkStore {
  /** Populate from the backing store. Safe to call more than once; only the
   *  first call does work. No-op for purely in-memory stores. */
  load?(): Promise<void>;
  /** Newest `create_at` the agent has been shown in this channel, or
   *  ``undefined`` when nothing has been recorded yet. */
  get(accountId: string, channelId: string): number | undefined;
  /** Record that the agent has now seen up to `createAt`. Monotonic — a
   *  value at or below the current watermark is ignored. */
  set(accountId: string, channelId: string, createAt: number): void;
  /** Force any pending write to disk (test seam / clean shutdown). */
  flush?(): Promise<void>;
}

const DEFAULT_STATE_FILENAME = "clawbits-channel-state.json";
const FLUSH_DEBOUNCE_MS = 1000;
const KEY_SEP = "\u0000";

/**
 * In-memory map with an optional JSON file behind it. When constructed
 * without a file path it behaves as a pure in-memory store (load/flush are
 * no-ops) — handy for tests and the "no persistence" fallback.
 */
export class ChannelWatermarkStore implements WatermarkStore {
  private readonly map = new Map<string, number>();
  private readonly filePath: string | null;
  private loaded = false;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(filePath?: string | null) {
    this.filePath = filePath ?? null;
  }

  /** File-backed store at `filePath` (defaults to ``<cwd>/<state file>``). */
  static fileBacked(filePath?: string): ChannelWatermarkStore {
    return new ChannelWatermarkStore(
      filePath ?? resolve(process.cwd(), DEFAULT_STATE_FILENAME),
    );
  }

  /** Pure in-memory store (no disk I/O). */
  static inMemory(): ChannelWatermarkStore {
    return new ChannelWatermarkStore(null);
  }

  private keyFor(accountId: string, channelId: string): string {
    return `${accountId}${KEY_SEP}${channelId}`;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        for (const [accountId, channels] of Object.entries(parsed as Record<string, unknown>)) {
          if (!channels || typeof channels !== "object") continue;
          for (const [channelId, value] of Object.entries(channels as Record<string, unknown>)) {
            if (typeof value === "number" && Number.isFinite(value)) {
              this.map.set(this.keyFor(accountId, channelId), value);
            }
          }
        }
      }
    } catch {
      // Missing or corrupt file → start from an empty watermark set. A bad
      // file just means the next backlog runs untrimmed (at worst a one-time
      // re-read), which is strictly safer than crashing the poller.
    }
  }

  get(accountId: string, channelId: string): number | undefined {
    return this.map.get(this.keyFor(accountId, channelId));
  }

  set(accountId: string, channelId: string, createAt: number): void {
    if (!Number.isFinite(createAt)) return;
    const key = this.keyFor(accountId, channelId);
    const current = this.map.get(key);
    if (current !== undefined && createAt <= current) return;
    this.map.set(key, createAt);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.filePath) return;
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    // Don't let a pending flush keep the process alive on shutdown.
    this.flushTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.filePath || !this.dirty) return;
    this.dirty = false;
    const snapshot: Record<string, Record<string, number>> = {};
    for (const [key, value] of this.map) {
      const sep = key.indexOf(KEY_SEP);
      const accountId = sep >= 0 ? key.slice(0, sep) : key;
      const channelId = sep >= 0 ? key.slice(sep + 1) : "";
      (snapshot[accountId] ??= {})[channelId] = value;
    }
    const path = this.filePath;
    // Serialise writes so two rapid flushes can't interleave/corrupt the
    // file. Swallow write errors — a failed persist degrades to a one-time
    // re-read after restart, never a crash.
    this.flushChain = this.flushChain.then(() =>
      writeFile(path, JSON.stringify(snapshot), "utf8").catch(() => {}),
    );
    await this.flushChain;
  }
}
