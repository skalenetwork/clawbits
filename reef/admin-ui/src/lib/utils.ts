import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Human-readable bytes (1024-based): 12_304_384 -> "11.7 MB". */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** i
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** CPU percent with sensible precision for tiny idle values. */
export function formatPercent(pct: number): string {
  if (pct <= 0) return "0%"
  if (pct < 1) return `${pct.toFixed(2)}%`
  return `${pct.toFixed(1)}%`
}

/** Seconds of uptime -> "2d 3h", "4h 12m", "9m". */
export function formatUptime(secs: number): string {
  if (!secs || secs < 0) return "—"
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.floor(secs)}s`
}

/** Build the URL that opens an agent's web terminal WITHOUT an auth prompt, by
 *  embedding the ttyd basic-auth credentials. The username is fixed by the image
 *  entrypoint (`--credential "reef:…"`). Works over both local http (dev
 *  DirectPort exposure) and the prod https tunnel — the surface proxy forwards
 *  `Authorization` to ttyd, so the browser's embedded creds skip its native
 *  prompt. The displayed/copied URL should stay the clean form — only the open
 *  action uses this. */
export function terminalAuthUrl(url: string, password: string): string {
  if (!password) return url
  const sep = url.indexOf("://")
  const scheme = sep < 0 ? "" : url.slice(0, sep + 3)
  if (scheme !== "http://" && scheme !== "https://") return url
  return `${scheme}reef:${encodeURIComponent(password)}@${url.slice(sep + 3)}`
}

/** Build the URL that opens the OpenClaw Control UI pre-authenticated, via the
 *  gateway's `#token=<token>` fragment (its native auto-auth). The fragment is
 *  client-only — never sent to the server, so it stays out of gateway logs.
 *  Works over http (dev) and https (prod). */
export function controlUiAuthUrl(url: string, token: string): string {
  if (!token) return url
  return `${url.replace(/\/+$/, "")}/#token=${encodeURIComponent(token)}`
}

/** Pre-authenticated "open" URL for an agent's PRIMARY web surface, by agent
 *  kind. OpenClaw/IronClaw's Control UI reads a `#token=` fragment; Hermes'
 *  dashboard sits behind the nginx basic-auth proxy (user `reef`, same secret
 *  as the terminal), where a `#token=` fragment would just land on the
 *  browser's 401 prompt — embed the creds instead, terminal-style. */
export function surfaceAuthUrl(
  kind: string | null | undefined,
  url: string,
  secret: string,
): string {
  return kind === "hermes" ? terminalAuthUrl(url, secret) : controlUiAuthUrl(url, secret)
}

/** Compact "time ago" from an ISO timestamp. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "—"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "—"
  const diff = Math.max(0, Date.now() - then)
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/** Ultra-compact age for tight spots (sidebar rows): "now", "5m", "2h", "3d",
 *  "2w", "4mo", "1y". No "ago" suffix — context makes it clear. */
export function shortAge(iso: string | null): string {
  if (!iso) return ""
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return "now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  if (d < 30) return `${Math.floor(d / 7)}w`
  if (d < 365) return `${Math.floor(d / 30)}mo`
  return `${Math.floor(d / 365)}y`
}

/** Absolute, human date-time (locale-aware): "Jun 8, 2026, 2:32 PM". */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}
