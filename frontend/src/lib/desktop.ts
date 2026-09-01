// Type-only import (erased at build time) so we can hold the updater's Update
// handle without taking a runtime dependency on the plugin - the lazy-import
// discipline below keeps the plugin out of the web bundle.
import type { Update } from "@tauri-apps/plugin-updater";
export type { Update };

/**
 * Whether the app is running inside the Tauri desktop shell.
 * Set on first import; safe to read in module scope.
 */
export const isDesktop: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Stamps the platform attribute on <html> so CSS variables in index.css
 * can switch on it. Synchronous — call before React renders.
 *
 * Sniffs navigator.userAgent rather than awaiting @tauri-apps/plugin-os
 * to stay sync (an async detect would let the macOS traffic-light
 * clearance flash from 0 to 68px between first paint and resolution).
 * WebKit2GTK on Linux reports "Linux"; WebKit on macOS reports
 * "Mac OS X"; WebView2 on Windows reports "Windows" — reliable enough
 * for the platform branches we care about.
 */
export function setupDesktopAttributes(): void {
  if (!isDesktop || typeof document === "undefined") return;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const platform = /Mac OS X/i.test(ua)
    ? "macos"
    : /Linux/i.test(ua)
      ? "linux"
      : /Windows/i.test(ua)
        ? "windows"
        : "macos";
  document.documentElement.setAttribute("data-tauri-platform", platform);
}

const AUTH_TOKEN_KEY = "fc_desktop_auth_token";
const AUTH_RESPONSE_PATHS = [
  "/api/auth/magic/verify",
  "/api/auth/dev/login",
  "/api/auth/social/verify-email",
];
const LOGOUT_PATHS = [
  "/api/auth/logout",
  "/api/auth/dev/logout",
];

function getStoredAuthToken(): string | null {
  if (!isDesktop || typeof window === "undefined") return null;
  return window.localStorage.getItem(AUTH_TOKEN_KEY);
}

function setStoredAuthToken(token: string): void {
  if (!isDesktop || typeof window === "undefined") return;
  try { window.localStorage.setItem(AUTH_TOKEN_KEY, token); } catch { /* quota */ }
}

function clearStoredAuthToken(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(AUTH_TOKEN_KEY); } catch { /* quota */ }
}

const PENDING_OAUTH_STATE_KEY = "fc_desktop_oauth_state";
/** Matches the ``max_age=600`` the backend puts on its OAuth state cookie —
 *  a nonce older than that belongs to a flow the server has already
 *  forgotten, so accepting it could only ever be a replay. */
const PENDING_OAUTH_STATE_TTL_MS = 10 * 60_000;

/**
 * Mint a one-shot nonce for a desktop OAuth login and remember it.
 *
 * The system browser, not the app, receives the OAuth callback; the app
 * learns the outcome from a `clawbits://oauth-callback` URL that *any*
 * local program can forge — including a web page pointing an iframe at
 * the scheme handler. The nonce is what distinguishes a real callback
 * from a forged one: it goes out on the start URL, rides the WorkOS
 * `state` round trip, and must come back in the deep link.
 *
 * Persisted rather than held in memory so the flow survives both a
 * webview reload and the cold-start case where the OS relaunches the app
 * to deliver the URL. localStorage is no more exposed than the session
 * token already stored beside it.
 */
export function beginDesktopOAuth(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    window.localStorage.setItem(
      PENDING_OAUTH_STATE_KEY,
      JSON.stringify({ nonce, at: Date.now() }),
    );
  } catch { /* quota */ }
  return nonce;
}

/**
 * Consume the pending nonce and report whether `state` matches it.
 *
 * One shot: the stored nonce is dropped whether or not it matched, so a
 * deep link can never be replayed and a failed attempt can't be probed
 * repeatedly against the same secret.
 */
function consumePendingOAuthState(state: string | null): boolean {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PENDING_OAUTH_STATE_KEY);
    window.localStorage.removeItem(PENDING_OAUTH_STATE_KEY);
  } catch { /* quota */ }
  if (!raw || !state) return false;
  try {
    const pending = JSON.parse(raw) as { nonce?: unknown; at?: unknown };
    if (typeof pending.nonce !== "string" || typeof pending.at !== "number") return false;
    if (Date.now() - pending.at > PENDING_OAUTH_STATE_TTL_MS) return false;
    return pending.nonce === state;
  } catch {
    return false;
  }
}

let sessionIsLive = false;

/**
 * Mirror of "AuthContext currently has a user", used by the deep-link
 * handler to refuse a token hand-off mid-session.
 *
 * Deliberately NOT derived from `getStoredAuthToken()`: the stored token
 * is only cleared on an explicit logout, so it outlives its own session.
 * Gating on its presence would refuse the deep link of a user who is
 * legitimately signing back in after an expiry — locking them out for
 * good.
 */
export function setDesktopSessionLive(live: boolean): void {
  sessionIsLive = live;
}

/**
 * Install a window.fetch wrapper that:
 *  - rewrites relative /api/* to VITE_CLAWBITS_API_URL (built desktop only),
 *  - on desktop: injects Authorization: Bearer <stored-token> on requests
 *    to our own API (same-origin /api/* or the configured apiBase) if no
 *    auth header is already set,
 *  - on desktop: captures `token` from auth-success responses and persists
 *    it; clears on logout.
 *
 * The Authorization header is intentionally NOT added to third-party
 * fetches (e.g. CDN data) — a custom header would trigger a CORS preflight
 * that arbitrary hosts don't permit, hanging the request.
 *
 * No-op on web when VITE_CLAWBITS_API_URL is unset.
 */
export function setupApiClient(): void {
  const apiBase = (import.meta.env.VITE_CLAWBITS_API_URL as string | undefined) || "";
  if (!isDesktop && !apiBase) return;

  const apiBaseOrigin: string | null = (() => {
    if (!apiBase) return null;
    try { return new URL(apiBase).origin; } catch { return null; }
  })();

  const isOwnApiRequest = (url: string): boolean => {
    try {
      const u = new URL(url, window.location.href);
      if (u.pathname.startsWith("/api/") && u.origin === window.location.origin) return true;
      if (apiBaseOrigin && u.origin === apiBaseOrigin && u.pathname.startsWith("/api/")) return true;
      return false;
    } catch {
      return false;
    }
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    // Compute the URL string for matching + the headers to send.
    const inputUrl: string =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url;

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (isDesktop && isOwnApiRequest(inputUrl) && !headers.has("authorization")) {
      const token = getStoredAuthToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }

    // Rewrite relative /api/* to the absolute base, if configured.
    let finalInput: RequestInfo | URL = input;
    if (apiBase) {
      if (typeof input === "string" && input.startsWith("/api/")) {
        finalInput = apiBase + input;
      } else if (input instanceof URL && !input.host && input.pathname.startsWith("/api/")) {
        finalInput = apiBase + input.pathname + input.search;
      } else if (input instanceof Request) {
        const u = new URL(input.url, window.location.href);
        if (u.pathname.startsWith("/api/") && u.origin === window.location.origin) {
          finalInput = new Request(apiBase + u.pathname + u.search, input);
        }
      }
    }

    const response = await origFetch(finalInput, { ...init, headers });

    // Side effects: capture/clear auth token (desktop only)
    if (isDesktop && response.ok) {
      if (AUTH_RESPONSE_PATHS.some((p) => inputUrl.includes(p))) {
        try {
          const body = (await response.clone().json()) as { token?: unknown };
          if (typeof body.token === "string") setStoredAuthToken(body.token);
        } catch { /* non-JSON response */ }
      } else if (LOGOUT_PATHS.some((p) => inputUrl.includes(p))) {
        clearStoredAuthToken();
      }
    }
    return response;
  };
}

const APP_BG_TRANSPARENT_KEY = "fc_app_bg_transparent";
/** Alpha applied to the app surface tokens when transparency is ON. We point
 *  --app-bg-opacity at the theme-aware --app-bg-opacity-on (defined per
 *  light/dark in index.css) rather than a fixed number, so light mode can stay
 *  more opaque (easier to read over a bright desktop) while dark stays airier —
 *  and a live theme switch re-resolves without re-running this. The literal is
 *  a fallback if the CSS var is somehow missing. */
const APP_BG_TRANSPARENT_VALUE = "var(--app-bg-opacity-on, 0.4)";

/** Whether window translucency is enabled. Defaults to ON. */
export function getStoredAppBgTransparent(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(APP_BG_TRANSPARENT_KEY);
  if (raw == null) return true;
  return raw !== "false";
}

/** Toggles the underlying CSS variable + persists. Web no-op (always opaque). */
export function setAppBgTransparent(enabled: boolean): void {
  if (!isDesktop || typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--app-bg-opacity",
    enabled ? APP_BG_TRANSPARENT_VALUE : "1",
  );
  try {
    window.localStorage.setItem(APP_BG_TRANSPARENT_KEY, String(enabled));
  } catch {
    /* ignore — storage quota / private mode */
  }
}

/** Apply persisted transparency state on app boot. Call once from main.tsx. */
export function applyStoredAppBgTransparent(): void {
  if (!isDesktop) return;
  setAppBgTransparent(getStoredAppBgTransparent());
}

/**
 * Open a URL "externally" — in the system default browser on desktop, in
 * a new tab on web. Use this anywhere we'd previously have done
 * ``window.open(url, "_blank")`` for downloads/external links: in Tauri,
 * ``window.open`` opens a NEW WebView window instead of triggering an OS
 * download, which is almost never what we want.
 */
export async function openExternal(url: string): Promise<void> {
  if (isDesktop) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
      return;
    } catch {
      /* fall through to browser-style new-tab */
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Updater plumbing. Thin, UI-free wrappers around the Tauri updater + process
 * plugins; the update lifecycle and every user-facing surface live in
 * UpdateContext / UpdateBanner. Kept here to preserve this file's lazy-import +
 * no-op-on-web discipline (the plugins only load inside the desktop shell).
 *
 * The signed manifest is at the URL configured in tauri.conf.json's
 * ``plugins.updater.endpoints`` - the GitHub Releases ``latest.json`` of
 * skalenetwork/clawbits in prod; empty in dev/staging so those never self-update.
 */

/**
 * Ask the configured endpoint for a newer signed release. Resolves to the
 * Update handle (call ``downloadAndInstall`` on it) when one is available, or
 * null when already up to date. Returns null on web. Real failures (offline,
 * no endpoint configured, bad signature) reject - callers decide whether to
 * surface them (manual check) or stay quiet (background poll).
 */
export async function checkForUpdate(): Promise<Update | null> {
  if (!isDesktop) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  return check({ timeout: 30_000 });
}

/** Relaunch to apply a staged update. No-op on web. */
export async function relaunchApp(): Promise<void> {
  if (!isDesktop) return;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/**
 * Sets the macOS dock badge to the given unread count. No-op on web and
 * on non-macOS desktop platforms. Failures are swallowed — a stale badge
 * is better than a broken render path.
 */
export async function setDockBadge(count: number): Promise<void> {
  if (!isDesktop) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_dock_badge", { count: Math.max(0, Math.floor(count)) });
  } catch {
    /* ignore — non-critical UX */
  }
}

/**
 * Is the user actually looking at the app right now?
 *
 * `document.hasFocus()` is not trustworthy in the desktop shell. Closing the
 * window hides it rather than destroying it (see the CloseRequested handler in
 * src-tauri/src/lib.rs), and WebKitGTK does not reliably clear the document's
 * focus flag when the GTK window is hidden — so on Linux `hasFocus()` could
 * keep reporting `true` for a window the user cannot see, suppressing every
 * notification for the entire session.
 *
 * The window manager is the authority, so ask Tauri. Both conditions are
 * required: a minimised or fully-hidden window still reports visible on some
 * platforms, and a window on another workspace is visible but not focused.
 * Falls back to the DOM only if the Tauri call fails outright.
 */
export async function isAppInForeground(): Promise<boolean> {
  const domFocus = typeof document !== "undefined" && document.hasFocus();
  if (!isDesktop) return domFocus;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const [visible, focused] = await Promise.all([win.isVisible(), win.isFocused()]);
    return visible && focused;
  } catch {
    return domFocus;
  }
}

/**
 * Fire a native desktop notification for an incoming chat message.
 *
 * Routes through the `notify_channel_message` Rust command instead of the
 * Tauri notification plugin so we can pass `channelId`: the Rust side keeps
 * the last notification id per channel and replaces that banner in place
 * (`replaces_id` on Linux, `threadIdentifier` grouping on macOS) rather than
 * stacking one banner per message. The Tauri plugin discards identifier/group
 * fields on desktop, hence the bypass.
 */
export async function notifyForPost(opts: {
  channelId: string;
  channelName: string;
  authorName: string;
  body: string;
}): Promise<void> {
  if (!isDesktop) return;
  // Skip when the user is already looking at the app — the unread badge
  // is feedback enough; a notification would be redundant noise.
  if (await isAppInForeground()) return;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("notify_channel_message", {
      message: {
        channelId: opts.channelId,
        channelName: opts.channelName,
        authorName: opts.authorName,
        body: opts.body,
      },
    });
  } catch {
    /* Notification daemon unavailable or user denied — silent failure. */
  }
}

/** What the shell can tell us about native notification delivery. Mirrors the
 *  `Diagnostics` struct in src-tauri/src/notifications.rs. */
export interface NotificationDiagnostics {
  /** "linux" | "macos" | "other" */
  platform: string;
  supported: boolean;
  serverName: string | null;
  serverVendor: string | null;
  capabilities: string[];
  /** The `DesktopEntry` hint we send, and the installed .desktop file matching
   *  it. A hint with no matching file is why GNOME drops notifications. */
  desktopEntry: string | null;
  desktopFile: string | null;
  notifySend: string | null;
  error: string | null;
}

/** Fire a test notification through the real delivery path. Throws when the
 *  command itself fails, which is distinct from the daemon dropping it — the
 *  caller should say so rather than claiming success. */
export async function sendTestNotification(): Promise<void> {
  if (!isDesktop) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("notify_debug_ping");
}

/** Read notification diagnostics from the shell. Returns null off-desktop or
 *  when the shell is too old to know the command. */
export async function getNotificationDiagnostics(): Promise<NotificationDiagnostics | null> {
  if (!isDesktop) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<NotificationDiagnostics>("notify_diagnostics");
  } catch {
    return null;
  }
}


/**
 * Channel-aware deep-link prefixes. Each desktop build only registers one
 * scheme with the OS (prod → clawbits, staging → clawbits-staging,
 * dev → clawbits-dev) so installs can coexist without colliding on
 * mime-handler routing. The listener accepts any of them so a single
 * frontend bundle works across channels — the URL.protocol check below
 * still verifies the URL is actually one of ours.
 */
const KNOWN_DEEP_LINK_PROTOCOLS = new Set([
  "clawbits:",
  "clawbits-staging:",
  "clawbits-dev:",
]);

/**
 * Listen for clawbits:// (and channel-suffixed) URLs delivered by the OS
 * after OAuth completes in the system browser, or any other deep-link
 * source. Currently handles one host: `oauth-callback`, which carries
 * the sealed session ``token`` — we persist it and bounce to /home so
 * AuthContext re-probes /me with the Bearer header. Listens for the
 * same event the Rust setup() fires in both cold-start (initial-URL)
 * and warm hand-off cases.
 *
 * Treat the payload as hostile. The OS routes the scheme to us from
 * whatever fired it, so an attacker who hosts
 * `<iframe src="clawbits://oauth-callback?token=…">` can hand this
 * listener a session they control — and since the stored token becomes
 * the `Authorization: Bearer` on every API call, and the backend prefers
 * Bearer over the cookie, the victim would go on working normally inside
 * the attacker's account. Two things gate the hand-off: the callback
 * must echo the nonce from a login this install started, and there must
 * be no live session to displace.
 */
export async function setupDeepLinkListener(): Promise<void> {
  if (!isDesktop) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("clawbits://deep-link", (event) => {
    const url = event.payload;
    if (typeof url !== "string") return;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return; }
    if (!KNOWN_DEEP_LINK_PROTOCOLS.has(parsed.protocol)) return;
    if (parsed.host === "oauth-callback") {
      const token = parsed.searchParams.get("token");
      if (!token) return;
      // Never swap the session out from under a signed-in user. Mirrors
      // the mobile handler's `status === 'authenticated'` early return in
      // apps/mobile/src/app/_layout.tsx.
      if (sessionIsLive) return;
      // Bind the callback to a login this install actually started.
      if (!consumePendingOAuthState(parsed.searchParams.get("state"))) return;
      setStoredAuthToken(token);
      window.location.replace("/home");
    }
  });
}

/**
 * Mirrors the Tauri window's fullscreen state onto <html data-fullscreen>.
 * CSS uses it to collapse the traffic-light clearance when traffic lights
 * are hidden (macOS fullscreen mode).
 */
export async function setupFullscreenSync(): Promise<void> {
  if (!isDesktop || typeof document === "undefined") return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const sync = async () => {
    if (await win.isFullscreen()) {
      document.documentElement.setAttribute("data-fullscreen", "true");
    } else {
      document.documentElement.removeAttribute("data-fullscreen");
    }
  };
  await sync();
  await win.onResized(() => { void sync(); });
}

// =========================================================================
// Zoom (Cmd+= / Cmd+- / Cmd+0)
// =========================================================================
// Menu items in src-tauri/src/menu.rs emit `desktop://zoom` with "in",
// "out", or "reset". We translate that to a clamped scale, persist it
// in localStorage, and call the `set_zoom` Tauri command which routes
// to WebviewWindow::set_zoom on Rust's main thread.

const ZOOM_KEY = "fc_desktop_zoom";
const ZOOM_DEFAULT = 1.0;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;

function readZoom(): number {
  if (typeof window === "undefined") return ZOOM_DEFAULT;
  const raw = window.localStorage.getItem(ZOOM_KEY);
  const n = raw == null ? ZOOM_DEFAULT : Number(raw);
  return Number.isFinite(n) && n >= ZOOM_MIN && n <= ZOOM_MAX ? n : ZOOM_DEFAULT;
}

function writeZoom(n: number): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(ZOOM_KEY, String(n)); } catch { /* quota */ }
}

async function applyZoom(scale: number): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_zoom", { scale });
  } catch {
    /* ignore — invoke fails on web or if the command is unregistered */
  }
}

/** Replay the persisted zoom level on boot. Call once from main.tsx. */
export async function applyStoredZoom(): Promise<void> {
  if (!isDesktop) return;
  await applyZoom(readZoom());
}

/** Wire the desktop://zoom listener so menu shortcuts mutate the level. */
export async function setupZoomShortcuts(): Promise<void> {
  if (!isDesktop) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("desktop://zoom", (event) => {
    const cur = readZoom();
    const next =
      event.payload === "in"
        ? Math.min(ZOOM_MAX, +(cur + ZOOM_STEP).toFixed(2))
        : event.payload === "out"
          ? Math.max(ZOOM_MIN, +(cur - ZOOM_STEP).toFixed(2))
          : ZOOM_DEFAULT;
    writeZoom(next);
    void applyZoom(next);
  });
}

// =========================================================================
// Recent channels (Window → Recent submenu)
// =========================================================================
// Frontend owns the list (most-recent-first, deduped, capped); on every
// mutation we mirror it to the Rust menu via `set_recent_channels`.

const RECENT_KEY = "fc_desktop_recent_channels";
const RECENT_CAP = 10;

export interface RecentChannel {
  id: string;
  name: string;
  path: string;
}

function readRecents(): RecentChannel[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is RecentChannel =>
        x != null &&
        typeof x === "object" &&
        typeof (x as RecentChannel).id === "string" &&
        typeof (x as RecentChannel).name === "string" &&
        typeof (x as RecentChannel).path === "string",
    );
  } catch {
    return [];
  }
}

function writeRecents(items: RecentChannel[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, RECENT_CAP)));
  } catch {
    /* quota */
  }
}

async function syncRecentsToMenu(items: RecentChannel[]): Promise<void> {
  if (!isDesktop) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_recent_channels", { items: items.slice(0, RECENT_CAP) });
  } catch {
    /* ignore — invoke fails on web or if the command is unregistered */
  }
}

/** Push a channel onto the recents list (dedupe by id, cap at 10). */
export function trackRecentChannel(channel: RecentChannel): void {
  if (!isDesktop) return;
  const items = readRecents();
  if (items[0]?.id === channel.id) {
    // Already at the top — only update the cached name (it may have
    // changed since the last visit) without thrashing the menu.
    if (items[0].name !== channel.name || items[0].path !== channel.path) {
      const next = [channel, ...items.slice(1)];
      writeRecents(next);
      void syncRecentsToMenu(next);
    }
    return;
  }
  const filtered = items.filter((c) => c.id !== channel.id);
  const next = [channel, ...filtered].slice(0, RECENT_CAP);
  writeRecents(next);
  void syncRecentsToMenu(next);
}

/** Hydrate the menu from localStorage on boot. Call once from main.tsx. */
export async function syncStoredRecentChannels(): Promise<void> {
  if (!isDesktop) return;
  await syncRecentsToMenu(readRecents());
}

// =========================================================================
// Open-channel listener
// =========================================================================
// Rust emits `desktop://open-channel` with a route path when the user
// clicks an item under Window → Recent. The hook that calls this must
// own a `useNavigate` from react-router; we accept it as a callback.

export async function listenForOpenChannel(
  navigate: (path: string) => void,
): Promise<() => void> {
  const noop = (): void => {
    /* no listener to detach on web */
  };
  if (!isDesktop) return noop;
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<string>("desktop://open-channel", (event) => {
    if (typeof event.payload === "string" && event.payload.startsWith("/")) {
      navigate(event.payload);
    }
  });
  return unlisten;
}

// =========================================================================
// Notification click
// =========================================================================
// Rust emits `clawbits://notification-activated` with the channel id when the
// user clicks one of our native notifications. The shell has already raised
// the window by the time this arrives; all that is left is to land on the
// right channel — the desktop counterpart of the service worker's
// `push-navigate` message on the web (see lib/push.ts).
//
// Linux only today: routing a click needs the notification daemon's `actions`
// capability. On macOS a click still activates the app but stays wherever the
// user was, until a UNUserNotificationCenterDelegate is wired up.

export async function listenForNotificationActivation(
  navigate: (path: string) => void,
): Promise<() => void> {
  const noop = (): void => {
    /* no listener to detach on web */
  };
  if (!isDesktop) return noop;
  const { listen } = await import("@tauri-apps/api/event");
  return await listen<string>("clawbits://notification-activated", (event) => {
    const channelId = event.payload;
    // The payload is an opaque channel id from our own shell, but it lands in
    // a router path, so keep it to characters an id can actually contain.
    if (typeof channelId !== "string" || !/^[A-Za-z0-9_-]+$/.test(channelId)) return;
    navigate(`/channels/${channelId}`);
  });
}
