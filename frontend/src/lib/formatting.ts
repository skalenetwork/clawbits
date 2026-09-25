import type { MmChannelPost, ReefHostAgent } from "@/lib/api";

/** Backend timestamps are UTC, but SQLite emits them without a zone ("2026-04-16 17:06:00"), which Date reads as local. */
export function parseUtcTimestamp(timestamp: string | number): Date {
  if (typeof timestamp === "number") return new Date(timestamp);
  const trimmed = timestamp.trim();
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed) ? trimmed : `${trimmed.replace(" ", "T")}Z`);
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

type AgentRuntime = "openclaw" | "hermes" | "ironclaw";

interface AgentImage {
  tag: string;
  label: string;
  scheme: { runtime: AgentRuntime; engine: string; plugin: string } | null;
}

const TAG_RUNTIME: Record<string, AgentRuntime> = { oc: "openclaw", hm: "hermes", ic: "ironclaw" };
const IMAGE_TAG = /^(oc|hm|ic)(\d+(?:\.\d+)*)-pl(\d+(?:\.\d+)*)(?:-g[0-9a-f]+)?$/;

/** `oc2026.9.4-pl0.17.24-g72359f5` is OpenClaw engine 2026.9.4 carrying plugin 0.17.24, built at an optional commit. */
export function parseAgentImage(image: string): AgentImage {
  const [path = "", digest] = image.trim().split("@");
  const tail = path.slice(path.lastIndexOf("/") + 1);
  const colon = tail.indexOf(":");
  const tag = colon === -1 ? "" : tail.slice(colon + 1);
  const short = digest?.split(":").pop()?.slice(0, 7);
  const [, prefix = "", engine = "", plugin = ""] = IMAGE_TAG.exec(tag) ?? [];
  const runtime = TAG_RUNTIME[prefix];
  return {
    tag,
    label: short === undefined ? tail : `${tail}@${short}`,
    scheme: runtime ? { runtime, engine, plugin } : null,
  };
}

/** The plugin version the agent reports wins over the tag: a plugin updates itself inside the VM. */
export function formatAgentVersion({ tag, label, scheme }: AgentImage, reported?: string | null): string {
  if (scheme === null) return tag || label;
  return `${scheme.engine} · ${reported || scheme.plugin}`;
}

export const RUNTIME_LOGO: Record<string, string> = {
  openclaw: "/openclaw.png",
  hermes: "/hermes.png",
  ironclaw: "/ironclaw.png",
};

export const fleetKey = (host: string, name: string) => `${host}/${name}`;

export function reefAttention(row: ReefHostAgent): { bad?: boolean; label: string } | null {
  if (row.state === "failed") return { bad: true, label: "failed" };
  if (!row.role_current) return { label: "update pending" };
  if (!row.synced) return { label: "syncing" };
  if (row.state === "running") return null;
  return { label: row.state === "pending" ? "starting" : row.state };
}

/** DM channels are stored as `DM: <human> ↔ <agent>`, search results as `DM: <name>`; both render as the peer. */
export function formatChannelTitle(displayName: string | null | undefined, fallback = "Channel"): string {
  const name = displayName?.trim();
  if (!name) return fallback;
  return /^DM:\s*.+?\s*↔\s*(.+?)\s*$/.exec(name)?.[1] ?? /^DM:\s*(.+?)\s*$/.exec(name)?.[1] ?? name;
}

export function channelListTitle(channel: {
  channel_type: string;
  name: string;
  display_name?: string | null;
}): string {
  if (channel.channel_type === "agent_chat") return channel.display_name?.trim() || "New chat";
  return formatChannelTitle(
    channel.display_name ?? channel.name,
    channel.channel_type === "direct" ? "Direct message" : "Channel",
  );
}

export function formatRelativeShort(ts: string | number | null | undefined): string {
  if (ts == null || ts === "") return "";
  const d = parseUtcTimestamp(ts);
  if (Number.isNaN(d.getTime())) return "";
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatRelativeAgo(ts: string | number | null | undefined): string {
  const short = formatRelativeShort(ts);
  if (short === "") return "";
  if (short === "now") return "just now";
  return /^\d+[mhd]$/.test(short) ? `${short} ago` : `on ${short}`;
}

/** A server-bucketed privacy label ("recently", "within a week") wins over the raw timestamp. */
export function resolveLastSeen(ts: string | null | undefined, label: string | null | undefined): string {
  return label || formatLastSeen(ts);
}

export function formatLastSeen(ts: string | null | undefined): string {
  if (ts == null || ts === "") return "offline";
  const d = parseUtcTimestamp(ts);
  if (Number.isNaN(d.getTime())) return "offline";
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} hour${diffH === 1 ? "" : "s"} ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return "yesterday";
  if (diffD < 7) return `${diffD} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatTimeOnly(ts: string): string {
  const d = parseUtcTimestamp(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function sameDay(a: Date | number, b: Date | number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** Compact human duration: 340ms, 2.1s, 1m 5s, 2h 5m. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m >= 60) return `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
  const rem = Math.round(s % 60);
  return `${String(m)}m ${String(rem)}s`;
}

/** When a post was sent, or when a streamed reply started and completed, and its last edit. */
export function postMoments(
  post: Pick<MmChannelPost, "created_at" | "published_at" | "edited_at" | "status">,
): { label: string; at: string }[] {
  const created = parseUtcTimestamp(post.created_at);
  const published = post.published_at ? parseUtcTimestamp(post.published_at) : created;
  const took = published.getTime() - created.getTime();
  const at = (d: Date) =>
    d.toLocaleString(undefined, sameDay(d, created) ? { timeStyle: "medium" } : { dateStyle: "medium", timeStyle: "medium" });
  const moments = [
    {
      label: post.status === "streaming" || took > 0 ? "Started" : "Sent",
      at: created.toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" }),
    },
  ];
  if (took > 0) moments.push({ label: "Completed", at: `${at(published)} (took ${formatDuration(took) ?? ""})` });
  if (post.edited_at) moments.push({ label: "Edited", at: at(parseUtcTimestamp(post.edited_at)) });
  return moments;
}

export function formatDayLabel(ts: string): string {
  const d = parseUtcTimestamp(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric", weekday: "short" }
    : { month: "short", day: "numeric", year: "numeric" });
}
