/**
 * Parse a backend timestamp as UTC. The backend stores everything in UTC, but
 * SQLite TIMESTAMP strings are emitted without a timezone marker (e.g.
 * "2026-04-16 17:06:00") which `new Date(...)` would interpret as local time.
 * This helper normalises bare strings to UTC; ISO strings with an explicit
 * offset (Z or ±HH:MM) and numeric epoch values are passed through.
 */
export function parseUtcTimestamp(timestamp: string | number): Date {
  if (typeof timestamp === "number") return new Date(timestamp);
  const trimmed = timestamp.trim();
  // Already has timezone info — let the Date constructor handle it.
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) return new Date(trimmed);
  // SQLite "YYYY-MM-DD HH:MM:SS[.ffffff]" → ISO + Z so it's parsed as UTC.
  const iso = trimmed.replace(" ", "T") + "Z";
  return new Date(iso);
}

/**
 * Human-readable byte size: "812 B", "47 KB", "2.3 MB", "1.1 GB". Single
 * source of truth for attachment chips, message file cards, and the
 * attachments sidebar (each used to keep its own copy).
 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Render a channel display name. DM channels are stored as
 * `DM: <human> ↔ <agent>` (see backend `ensure_owner_agent_comm_channel`);
 * collapse that to just `<agent>` — the surrounding UI already conveys "this
 * is a direct message" via its grouping/iconography. Non-DM names pass through.
 */
export function formatChannelTitle(
  displayName: string | null | undefined,
  fallback = "Channel",
): string {
  const name = displayName?.trim();
  if (!name) return fallback;
  // `DM: <human> ↔ <agent>` → just `<agent>`.
  const peer = /^DM:\s*.+?\s*↔\s*(.+?)\s*$/.exec(name)?.[1];
  if (peer) return peer;
  // Fallback: a bare `DM: <name>` (no ↔) → `<name>`. This is the shape the
  // message-search endpoint returns for direct channels (the sidebar resolves
  // the peer name server-side; search results carry the stored display name).
  return /^DM:\s*(.+?)\s*$/.exec(name)?.[1] ?? name;
}

/** Time-of-day greeting for the home page ("Good morning" / "afternoon" /
 *  "evening"), based on the local clock. Pass a date in tests; defaults to now. */
export function getTimeOfDayGreeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** Long, human date for the home subline: "Tuesday, June 17". */
export function formatLongDate(now: Date = new Date()): string {
  return now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** Compact relative time ("now", "5m", "3h", "2d", "Apr 14"). */
export function formatRelativeShort(ts: string | number | null | undefined): string {
  if (ts == null || ts === "") return "";
  const d = parseUtcTimestamp(ts);
  if (Number.isNaN(d.getTime())) return "";
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${String(diffMin)}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${String(diffH)}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${String(diffD)}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Full past-tense phrase for a timestamp: "just now", "5m ago", "3h ago",
 *  "on Jun 20". One unit, so callers never compose broken strings like
 *  "now ago" / "Jun 20 ago" out of :func:`formatRelativeShort`. */
export function formatRelativeAgo(ts: string | number | null | undefined): string {
  const short = formatRelativeShort(ts);
  if (short === "") return "";
  if (short === "now") return "just now";
  // Duration forms end in a unit letter after digits ("5m", "3h", "2d");
  // anything else is a date ("Jun 20").
  return /^\d+[mhd]$/.test(short) ? `${short} ago` : `on ${short}`;
}

/** Resolve the right "Last seen …" string given either a bucketed
 *  privacy label (Telegram-style: "recently" / "within a week" / …)
 *  or a raw ISO timestamp. When ``label`` is set, it takes precedence —
 *  the server already decided to hide precision. Falls back to
 *  :func:`formatLastSeen` for the timestamp case.
 *
 *  Returns the *fragment* without the "Last seen " prefix so callers
 *  can decide whether to wrap it ("Online" / "Idle" / "Last seen X"). */
export function resolveLastSeen(
  ts: string | null | undefined,
  label: string | null | undefined,
): string {
  if (label) return label;
  return formatLastSeen(ts);
}

/** Long-form last-seen label for offline presence tooltips:
 *  "just now", "5 minutes ago", "2 hours ago", "yesterday",
 *  "3 days ago", or an absolute date for older. Null / empty input
 *  returns "offline" so callers can drop it straight into a tooltip. */
export function formatLastSeen(ts: string | null | undefined): string {
  if (ts == null || ts === "") return "offline";
  const d = parseUtcTimestamp(ts);
  if (Number.isNaN(d.getTime())) return "offline";
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${String(diffMin)} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${String(diffH)} hour${diffH === 1 ? "" : "s"} ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return "yesterday";
  if (diffD < 7) return `${String(diffD)} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Short time-only: "2:30 PM". */
export function formatTimeOnly(ts: string): string {
  const d = parseUtcTimestamp(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Day label for separators: "Today", "Yesterday", or "Apr 18, 2026". */
export function formatDayLabel(ts: string): string {
  const d = parseUtcTimestamp(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric", weekday: "short" }
    : { month: "short", day: "numeric", year: "numeric" });
}
