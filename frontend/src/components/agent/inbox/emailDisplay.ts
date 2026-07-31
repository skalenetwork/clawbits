/**
 * Presentation helpers for the agent inbox — sender parsing, deterministic
 * sender accents, and the date buckets that group the list. Pure functions,
 * no React.
 */
import { parseUtcTimestamp } from "@/lib/formatting";

/** Pull a friendly display name from a ``From``/``To`` header value, falling
 *  back to the address' local part. Handles ``Name <addr@host>`` and bare
 *  ``addr@host``. */
export function senderName(addr: string): string {
  const trimmed = addr.trim();
  const display = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(trimmed)?.[1]?.trim();
  if (display) return display;
  const bare = /<([^>]+)>/.exec(trimmed)?.[1] ?? trimmed;
  const local = bare.split("@")[0];
  if (local) return local;
  return bare;
}

/** The bare ``addr@host`` inside a ``From`` value (or the value itself). */
export function extractAddress(addr: string): string {
  const trimmed = addr.trim();
  return /<([^>]+)>/.exec(trimmed)?.[1] ?? trimmed;
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

/** Mail from the platform's own domains — other agents, system mail. These
 *  senders get the robot glyph instead of initials so agent↔agent mail reads
 *  differently from external mail at a glance. */
export function isPlatformAddress(addr: string): boolean {
  return /@(mail\.)?(clawbits|freeclaws)\.ai$/i.test(extractAddress(addr));
}

// ---------------------------------------------------------------------------
// Sender accents — a soft-tint register (quiet washes, colored text), distinct
// from the automations' saturated tile register. Same deterministic-hash idiom
// as `accentForId` so a sender keeps their color across reloads. Literal class
// strings so Tailwind sees them.
// ---------------------------------------------------------------------------

export interface SenderAccent {
  bg: string;
  text: string;
}

const DEFAULT_ACCENT: SenderAccent = {
  bg: "bg-blue-500/15",
  text: "text-blue-600 dark:text-blue-400",
};

const SENDER_ACCENTS: SenderAccent[] = [
  DEFAULT_ACCENT,
  { bg: "bg-violet-500/15", text: "text-violet-600 dark:text-violet-400" },
  { bg: "bg-teal-500/15", text: "text-teal-600 dark:text-teal-400" },
  { bg: "bg-amber-500/15", text: "text-amber-600 dark:text-amber-400" },
  { bg: "bg-rose-500/15", text: "text-rose-600 dark:text-rose-400" },
  { bg: "bg-emerald-500/15", text: "text-emerald-600 dark:text-emerald-400" },
  { bg: "bg-cyan-500/15", text: "text-cyan-600 dark:text-cyan-400" },
  { bg: "bg-orange-500/15", text: "text-orange-600 dark:text-orange-400" },
];

/** Stable soft-tint accent for a sender, keyed on their bare address. */
export function senderAccent(addr: string): SenderAccent {
  const key = extractAddress(addr).toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return SENDER_ACCENTS[Math.abs(hash) % SENDER_ACCENTS.length] ?? DEFAULT_ACCENT;
}

// ---------------------------------------------------------------------------
// Date buckets — the list's group headers. Coarser than per-day labels so an
// older mailbox doesn't dissolve into dozens of one-row groups.
// ---------------------------------------------------------------------------

export type DayBucket = "Today" | "Yesterday" | "This week" | "Earlier";

export function dayBucket(ts: string, now: number): DayBucket {
  const date = parseUtcTimestamp(ts);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const t = date.getTime();
  if (t >= startOfToday.getTime()) return "Today";
  if (t >= startOfToday.getTime() - dayMs) return "Yesterday";
  if (t >= startOfToday.getTime() - 6 * dayMs) return "This week";
  return "Earlier";
}
