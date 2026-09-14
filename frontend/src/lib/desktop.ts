import type { Update } from "@tauri-apps/plugin-updater";

export interface NotificationDiagnostics {
  platform: string;
  supported: boolean;
  serverName: string | null;
  serverVendor: string | null;
  capabilities: string[];
  desktopEntry: string | null;
  desktopFile: string | null;
  notifySend: string | null;
  error: string | null;
}

interface RecentChannel {
  id: string;
  name: string;
  path: string;
}

export const isDesktop = "__TAURI_INTERNALS__" in window;

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

async function onEvent(name: string, handler: (payload: string) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>(name, (event) => { handler(event.payload); });
}

async function mainWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
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
  const ua = navigator.userAgent;
  document.documentElement.dataset.tauriPlatform =
    /Mac OS X/i.test(ua) ? "macos" : /Linux/i.test(ua) ? "linux" : /Windows/i.test(ua) ? "windows" : "macos";
  setTranslucency(getStoredTranslucency());
  void command("set_zoom", { scale: readZoom() });
  void syncFullscreen();
  void setupDeepLinkListener();
  void onEvent("desktop://zoom", (direction) => {
    const zoom = readZoom();
    const next =
      direction === "in" ? Math.min(ZOOM_MAX, +(zoom + ZOOM_STEP).toFixed(2))
      : direction === "out" ? Math.max(ZOOM_MIN, +(zoom - ZOOM_STEP).toFixed(2))
      : 1;
    localStorage.setItem(ZOOM_KEY, String(next));
    void command("set_zoom", { scale: next });
  });
  void command("set_recent_channels", { items: readRecents() });
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
    if (!DEEP_LINK_PROTOCOLS.has(url.protocol) || url.host !== "oauth-callback") return;
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
    if (isDesktop && isOwnApi && !headers.has("authorization")) {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }

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
  const opened = isDesktop && (await import("@tauri-apps/plugin-shell").then(({ open }) => open(url)).then(() => true, () => false));
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

export async function setDockBadge(count: number): Promise<void> {
  if (isDesktop) await command("set_dock_badge", { count });
}

// document.hasFocus() stays true on WebKitGTK for a window hidden to the tray, so ask the window manager.
async function isAppInForeground(): Promise<boolean> {
  const win = await mainWindow();
  const [visible, focused] = await Promise.all([win.isVisible(), win.isFocused()]);
  return visible && focused;
}

/** Goes through our own command, not the notification plugin, so the shell can replace a channel's banner in place. */
export async function notifyForPost(message: {
  channelId: string;
  channelName: string;
  authorName: string;
  body: string;
}): Promise<void> {
  if (!isDesktop || (await isAppInForeground())) return;
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
  void command("set_recent_channels", { items: next });
}

export function listenForOpenChannel(navigate: (path: string) => void): Promise<() => void> {
  return onEvent("desktop://open-channel", (path) => {
    if (path.startsWith("/")) navigate(path);
  });
}

export function listenForNotificationActivation(navigate: (path: string) => void): Promise<() => void> {
  return onEvent("clawbits://notification-activated", (channelId) => {
    if (/^[A-Za-z0-9_-]+$/.test(channelId)) navigate(`/channels/${channelId}`);
  });
}
