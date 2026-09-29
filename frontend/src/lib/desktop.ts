import type { Update } from "@tauri-apps/plugin-updater";
import { isMac } from "@/lib/shortcuts/platform";

/** Linux only: macOS has no diagnostics command, the OS owns that story. */
export interface NotificationDiagnostics {
  serverName: string | null;
  desktopEntry: string;
  desktopFile: string | null;
  error: string | null;
}

/** Events the Rust shell emits, by payload. `desktop://navigate` is a route, "back" or "forward". */
export interface DesktopEvents {
  "clawbits://deep-link": string;
  "desktop://navigate": string;
  "desktop://zoom": string;
  "desktop://check-update": string;
  "desktop://reply": { channelId: string; text: string };
}

/** A menu entry that opens a route: Window > Recent and the tray's unread list. */
interface ChannelLink {
  name: string;
  path: string;
}

interface RecentChannel extends ChannelLink {
  id: string;
}

export const isDesktop = "__TAURI_INTERNALS__" in window;
export const isMacDesktop = isDesktop && isMac;

const AUTH_TOKEN_KEY = "fc_desktop_auth_token";
const AUTH_RESPONSE_PATHS = ["/api/auth/magic/verify", "/api/auth/dev/login", "/api/auth/social/verify-email"];
const LOGOUT_PATHS = ["/api/auth/logout", "/api/auth/dev/logout"];
const OAUTH_STATE_KEY = "fc_desktop_oauth_state";
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const DEEP_LINK_PROTOCOLS = new Set(["clawbits:", "clawbits-staging:", "clawbits-dev:"]);
const TRANSLUCENCY_KEY = "fc_app_bg_transparent";
const ZOOM_KEY = "fc_desktop_zoom";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
const RECENT_KEY = "fc_desktop_recent_channels";
const RECENT_CAP = 10;

let sessionIsLive = false;

async function command<T = void>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(name, args);
}

export async function onEvent<K extends keyof DesktopEvents>(
  name: K,
  handler: (payload: DesktopEvents[K]) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<DesktopEvents[K]>(name, (event) => { handler(event.payload); });
}

async function mainWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

async function applyZoom(scale: number): Promise<void> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().setZoom(scale);
}

function readZoom(): number {
  const zoom = Number(localStorage.getItem(ZOOM_KEY) ?? 1);
  return zoom >= ZOOM_MIN && zoom <= ZOOM_MAX ? zoom : 1;
}

function readRecents(): RecentChannel[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as RecentChannel[]) : [];
  } catch {
    return [];
  }
}

/** Stamps the platform synchronously, so the traffic-light clearance never flashes, then replays persisted window state. */
export function setupDesktop(): void {
  if (!isDesktop) return;
  document.documentElement.dataset.tauriPlatform = isMacDesktop ? "macos" : "linux";
  setTranslucency(getStoredTranslucency());
  void applyZoom(readZoom());
  void syncFullscreen();
  void setupDeepLinkListener();
  void onEvent("desktop://zoom", (direction) => {
    const zoom = readZoom();
    const next =
      direction === "in" ? Math.min(ZOOM_MAX, +(zoom + ZOOM_STEP).toFixed(2))
      : direction === "out" ? Math.max(ZOOM_MIN, +(zoom - ZOOM_STEP).toFixed(2))
      : 1;
    localStorage.setItem(ZOOM_KEY, String(next));
    void applyZoom(next);
  });
  void command("set_recent_channels", { channels: readRecents() });
  // WebKit's own menu (Reload, Open Link, Inspect Element) only where a Mac app shows one: fields and selected text.
  document.addEventListener("contextmenu", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("input, textarea, [contenteditable]")) return;
    if (!target?.closest("a[href]") && document.getSelection()?.isCollapsed === false) return;
    e.preventDefault();
  });
}

async function syncFullscreen(): Promise<void> {
  const win = await mainWindow();
  const sync = async () => {
    if (await win.isFullscreen()) document.documentElement.setAttribute("data-fullscreen", "true");
    else document.documentElement.removeAttribute("data-fullscreen");
  };
  await sync();
  await win.onResized(() => { void sync(); });
}

/** The app scheme a native client's MCP sign-in state starts with (`<scheme>.<random>`), if any. */
export function nativeScheme(state: string): string | undefined {
  const scheme = state.split(".", 1)[0];
  return DEEP_LINK_PROTOCOLS.has(`${scheme}:`) ? scheme : undefined;
}

/** A one-shot nonce for a desktop OAuth login: it rides the WorkOS `state` round trip, and the deep link must echo it. */
export function beginDesktopOAuth(): string {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(OAUTH_STATE_KEY, JSON.stringify({ nonce, at: Date.now() }));
  return nonce;
}

function consumePendingOAuthState(state: string | null): boolean {
  const raw = localStorage.getItem(OAUTH_STATE_KEY);
  localStorage.removeItem(OAUTH_STATE_KEY);
  if (!raw || !state) return false;
  const pending = JSON.parse(raw) as { nonce: string; at: number };
  return pending.nonce === state && Date.now() - pending.at <= OAUTH_STATE_TTL_MS;
}

/** Mirrors "AuthContext has a user". Not derived from the stored token, which outlives its session. */
export function setDesktopSessionLive(live: boolean): void {
  sessionIsLive = live;
}

/** Any page can fire the scheme, so a callback must echo a nonce this install minted and never displaces a live session. */
export async function setupDeepLinkListener(): Promise<void> {
  await onEvent("clawbits://deep-link", (payload) => {
    let url: URL;
    try {
      url = new URL(payload);
    } catch {
      return;
    }
    if (!DEEP_LINK_PROTOCOLS.has(url.protocol)) return;
    if (url.host === "mcp-callback") {
      window.location.assign(`/oauth/mcp/callback${url.search}`);
      return;
    }
    if (url.host !== "oauth-callback") return;
    const token = url.searchParams.get("token");
    if (!token || sessionIsLive || !consumePendingOAuthState(url.searchParams.get("state"))) return;
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    window.location.replace("/home");
  });
}

/** Points relative /api/* at VITE_CLAWBITS_API_URL and, on desktop, carries the session as a Bearer token on our own API only (a custom header would preflight third-party hosts). */
export function setupApiClient(): void {
  const apiBase = (import.meta.env.VITE_CLAWBITS_API_URL as string | undefined) || "";
  if (!isDesktop && !apiBase) return;
  const apiOrigin = apiBase && new URL(apiBase).origin;
  const origFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const inputUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(inputUrl, window.location.href);
    const isOwnApi = url.pathname.startsWith("/api/") && (url.origin === window.location.origin || url.origin === apiOrigin);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const token = isDesktop && isOwnApi && !headers.has("authorization") ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
    if (token) headers.set("Authorization", `Bearer ${token}`);

    let target: RequestInfo | URL = input;
    if (apiBase) {
      if (typeof input === "string") {
        if (input.startsWith("/api/")) target = apiBase + input;
      } else if (input instanceof URL) {
        if (!input.host && input.pathname.startsWith("/api/")) target = apiBase + input.pathname + input.search;
      } else if (url.pathname.startsWith("/api/") && url.origin === window.location.origin) {
        target = new Request(apiBase + url.pathname + url.search, input);
      }
    }

    const response = await origFetch(target, { ...init, headers });
    const rotated = token && response.headers.get("X-Clawbits-Session");
    if (rotated && localStorage.getItem(AUTH_TOKEN_KEY) === token) localStorage.setItem(AUTH_TOKEN_KEY, rotated);
    if (isDesktop && response.ok) {
      if (AUTH_RESPONSE_PATHS.some((p) => inputUrl.includes(p))) {
        const body = (await response.clone().json().catch(() => ({}))) as { token?: unknown };
        if (typeof body.token === "string") localStorage.setItem(AUTH_TOKEN_KEY, body.token);
      } else if (LOGOUT_PATHS.some((p) => inputUrl.includes(p))) {
        localStorage.removeItem(AUTH_TOKEN_KEY);
      }
    }
    return response;
  };
}

/** Whether the sidebars let the wallpaper through (macOS only). Defaults to on. */
export function getStoredTranslucency(): boolean {
  return localStorage.getItem(TRANSLUCENCY_KEY) !== "false";
}

export function setTranslucency(enabled: boolean): void {
  if (!isDesktop) return;
  document.documentElement.toggleAttribute("data-translucent", enabled);
  localStorage.setItem(TRANSLUCENCY_KEY, String(enabled));
}

/** The sidebar vibrancy follows the native window appearance, not CSS; `null` follows the system. */
export async function setWindowTheme(theme: "light" | "dark" | null): Promise<void> {
  if (isDesktop) await (await mainWindow()).setTheme(theme);
}

/** In Tauri, `window.open` spawns a new webview, so external links go to the system browser. */
export async function openExternal(url: string): Promise<void> {
  const opened = isDesktop && (await import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).then(() => true, () => false));
  if (!opened) window.open(url, "_blank", "noopener,noreferrer");
}

export async function checkForUpdate(): Promise<Update | null> {
  if (!isDesktop) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  return check({ timeout: 30_000 });
}

export async function relaunchApp(): Promise<void> {
  if (isDesktop) await (await import("@tauri-apps/plugin-process")).relaunch();
}

let unreadKey = "";

/** The dock badge (macOS; Linux launchers have none) and the menu bar icon's unread list, pushed on change. */
export function setDesktopUnread(badge: string | undefined, channels: ChannelLink[]): void {
  const key = JSON.stringify([badge, channels]);
  if (!isDesktop || key === unreadKey) return;
  unreadKey = key;
  if (isMacDesktop) void mainWindow().then((win) => win.setBadgeLabel(badge));
  void command("set_tray_unread", { channels });
}

// document.hasFocus() stays true on WebKitGTK for a window hidden to the tray, so ask the window manager.
async function isAppInForeground(): Promise<boolean> {
  const win = await mainWindow();
  const [visible, focused] = await Promise.all([win.isVisible(), win.isFocused()]);
  return visible && focused;
}

/** Goes through our own command, not the notification plugin, so the shell can replace a channel's banner in place.
 *  `attention` (a DM or mention) also bounces the dock once, or flashes the taskbar on Linux. */
export async function notifyForPost(
  message: { channelId: string; channelName: string; authorName: string; body: string },
  attention: boolean,
): Promise<void> {
  if (!isDesktop || (await isAppInForeground())) return;
  if (attention) {
    const { UserAttentionType } = await import("@tauri-apps/api/window");
    void (await mainWindow()).requestUserAttention(UserAttentionType.Informational);
  }
  await command("notify_channel_message", { message });
}

export async function sendTestNotification(): Promise<void> {
  if (!isDesktop) throw new Error("not running in the desktop app");
  await command("notify_debug_ping");
}

export async function getNotificationDiagnostics(): Promise<NotificationDiagnostics | null> {
  return isDesktop ? command<NotificationDiagnostics>("notify_diagnostics").catch(() => null) : null;
}

export function trackRecentChannel(channel: RecentChannel): void {
  if (!isDesktop) return;
  const items = readRecents();
  const top = items[0];
  if (top?.id === channel.id && top.name === channel.name && top.path === channel.path) return;
  const next = [channel, ...items.filter((c) => c.id !== channel.id)].slice(0, RECENT_CAP);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  void command("set_recent_channels", { channels: next });
}
