// Persistent per-(account, channel) watermarks, as a small JSON file. Three
// key shapes share the store:
//
//   "<channelId>"        — newest post already SHOWN as read-only context.
//   "cursor:<channelId>" — newest post whose turn FINISHED (or was refused).
//                          The boot catch-up resume point; written for every
//                          channel, DMs included.
//   "email:inbox"        — the email poller's UID watermark.
//
// On-disk: { "<accountId>": { "<key>": <createAtMs>, ... }, ... }
//
// DURABILITY: the default path prefers, in order, $CLAWBITS_STATE_DIR, then
// `~/.config/openclaw/clawbits/` when `~/.config/openclaw` exists (under reef
// that is a named volume that survives destroy+recreate — reef/profiles.py
// mounts it for auth-profile secrets), then the legacy `process.cwd()`
// location (container rootfs: survives stop/start but not recreate/upgrade).
// `load()` also reads the legacy cwd file once when the durable file doesn't
// exist yet, so an upgrade carries its watermarks over. Losing the file
// degrades to the poller's cold window / a server-pointer resume — bounded
// and duplicate-safe either way. Path is logged at poller start.
//
// NOTE: the primary restart resume point is the SERVER-side read pointer
// (`last_read_post_id`, acked on turn settle); this file is the fallback for
// older servers and the "shown as context" memory, which is client-local by
// nature.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";


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
  /** Resolved backing path, or null/undefined when purely in-memory. */
  readonly path?: string | null;
  /** Whether `load()` found existing state. Distinguishes a first-ever boot
   *  from "the state we had is gone" — very different for catch-up. */
  readonly loadedExisting?: boolean;
}

const DEFAULT_STATE_FILENAME = "clawbits-channel-state.json";
const FLUSH_DEBOUNCE_MS = 1000;
const KEY_SEP = "\u0000";

/** Legacy pre-0.16 location: the gateway's cwd. Read (never written) when
 *  the durable file doesn't exist yet, so upgrading carries state over. */
function legacyStatePath(): string {
  return resolve(process.cwd(), DEFAULT_STATE_FILENAME);
}

/** Durable default path — see the header note for the preference order. */
function defaultStatePath(): string {
  const envDir = process.env["CLAWBITS_STATE_DIR"];
  if (envDir && envDir.trim().length > 0) {
    return resolve(envDir.trim(), DEFAULT_STATE_FILENAME);
  }
  try {
    const configDir = join(homedir(), ".config", "openclaw");
    // Gate on the PARENT existing (not our subdir): its presence is what
    // signals "this install has a persistent config home" — reef's named
    // volume, or a self-hosted XDG setup. flush() creates the subdir.
    if (existsSync(configDir)) {
      return join(configDir, "clawbits", DEFAULT_STATE_FILENAME);
    }
  } catch {
    // homedir()/fs probing failed — fall through to the legacy location.
  }
  return legacyStatePath();
}

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
  loadedExisting = false;

  constructor(filePath?: string | null) {
    this.filePath = filePath ?? null;
  }

  /** Resolved backing path, or null for a pure in-memory store. Logged at
   *  poller start: the default lands wherever the gateway's cwd happens to be,
   *  which is worth seeing in the logs before trusting it. */
  get path(): string | null {
    return this.filePath;
  }

  /** File-backed store at `filePath` (defaults to the durable location —
   *  see `defaultStatePath`). */
  static fileBacked(filePath?: string): ChannelWatermarkStore {
    return new ChannelWatermarkStore(filePath ?? defaultStatePath());
  }

  /** Pure in-memory store (no disk I/O). */
  static inMemory(): ChannelWatermarkStore {
    return new ChannelWatermarkStore(null);
  }

  private keyFor(accountId: string, channelId: string): string {
    return `${accountId}${KEY_SEP}${channelId}`;
  }

  private ingestSnapshot(raw: string): boolean {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return false;
    for (const [accountId, channels] of Object.entries(parsed as Record<string, unknown>)) {
      if (!channels || typeof channels !== "object") continue;
      for (const [channelId, value] of Object.entries(channels as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          this.map.set(this.keyFor(accountId, channelId), value);
        }
      }
    }
    return true;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      this.loadedExisting = this.ingestSnapshot(await readFile(this.filePath, "utf8"));
      return;
    } catch {
      // Missing or corrupt durable file — try the legacy location below.
    }
    // One-time migration read: a pre-0.16 install kept the file in the
    // gateway's cwd. Ingest it (the next flush writes the durable path;
    // the old file is left behind, harmless). Skipped when the configured
    // path IS the legacy path.
    const legacy = legacyStatePath();
    if (legacy === this.filePath) return;
    try {
      this.loadedExisting = this.ingestSnapshot(await readFile(legacy, "utf8"));
      if (this.loadedExisting) this.dirty = true;
    } catch {
      // Neither file → a genuine first boot (or both corrupt). Start empty:
      // the next backlog runs untrimmed (at worst a one-time re-read), which
      // is strictly safer than crashing the poller.
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
    // Serialised so two rapid flushes can't interleave. tmp + rename because
    // rename is atomic: a SIGKILL mid-write can no longer leave truncated JSON
    // that `load()` silently discards as a cold start.
    this.flushChain = this.flushChain.then(async () => {
      const tmp = `${path}.tmp`;
      try {
        // The durable default lives in a subdir that may not exist yet
        // (`~/.config/openclaw/clawbits/`) — create it on first write.
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, JSON.stringify(snapshot), "utf8");
        await rename(tmp, path);
      } catch {
        // Swallowed: a failed persist degrades to a cold catch-up window on
        // the next boot, never a crash. The startup log reports whether state
        // was actually found, which is where a broken path shows up.
      }
    });
    await this.flushChain;
  }
}
