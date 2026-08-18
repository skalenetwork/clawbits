import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `clawbits://oauth-callback` deep link is an unauthenticated input: the
 * OS hands it to us from whatever fired the scheme, so a hostile web page can
 * deliver one with `<iframe src="clawbits://oauth-callback?token=…">`. Since
 * the stored token becomes the `Authorization: Bearer` on every API call, and
 * the backend prefers Bearer over the cookie, accepting an unbound token would
 * silently move the whole app into the attacker's account.
 *
 * These tests pin the two gates that stop that.
 */

const AUTH_TOKEN_KEY = "fc_desktop_auth_token";

/** Handler the module under test registers with Tauri's event bus. */
let deepLinkHandler: ((event: { payload: string }) => void) | null = null;

/** Stands in for `window.location.replace`, which jsdom leaves unimplemented
 *  and which the handler calls on a successful hand-off. */
const locationReplace = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (event: { payload: string }) => void) => {
    deepLinkHandler = handler;
    return Promise.resolve(() => undefined);
  },
}));

/**
 * `isDesktop` is computed once at import time from the presence of
 * `__TAURI_INTERNALS__`, so the flag has to be planted before the module is
 * pulled in — hence the dynamic import behind a fresh module registry.
 */
async function loadDesktopModule() {
  vi.resetModules();
  deepLinkHandler = null;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const mod = await import("@/lib/desktop");
  await mod.setupDeepLinkListener();
  return mod;
}

describe("desktop deep-link OAuth callback", () => {
  beforeEach(() => {
    window.localStorage.clear();
    locationReplace.mockClear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "http://localhost/", replace: locationReplace },
    });
  });

  function deliver(url: string) {
    expect(deepLinkHandler).not.toBeNull();
    deepLinkHandler?.({ payload: url });
  }

  function storedToken(): string | null {
    return window.localStorage.getItem(AUTH_TOKEN_KEY);
  }

  it("stores the token when the callback echoes a login we started", async () => {
    const mod = await loadDesktopModule();
    const nonce = mod.beginDesktopOAuth();

    deliver(`clawbits://oauth-callback?token=good-token&state=${nonce}`);

    expect(storedToken()).toBe("good-token");
    expect(locationReplace).toHaveBeenCalledWith("/home");
  });

  it("ignores a token with no state at all", async () => {
    const mod = await loadDesktopModule();
    mod.beginDesktopOAuth();

    deliver("clawbits://oauth-callback?token=attacker-session");

    expect(storedToken()).toBeNull();
    expect(locationReplace).not.toHaveBeenCalled();
  });

  it("ignores a token whose state does not match the pending nonce", async () => {
    const mod = await loadDesktopModule();
    mod.beginDesktopOAuth();

    deliver("clawbits://oauth-callback?token=attacker-session&state=guessed");

    expect(storedToken()).toBeNull();
  });

  it("ignores a callback that arrives with no login in flight", async () => {
    await loadDesktopModule();

    deliver("clawbits://oauth-callback?token=attacker-session&state=whatever");

    expect(storedToken()).toBeNull();
  });

  it("consumes the nonce so the same deep link cannot be replayed", async () => {
    const mod = await loadDesktopModule();
    const nonce = mod.beginDesktopOAuth();
    const url = `clawbits://oauth-callback?token=good-token&state=${nonce}`;

    deliver(url);
    expect(storedToken()).toBe("good-token");

    window.localStorage.removeItem(AUTH_TOKEN_KEY);
    deliver(url);
    expect(storedToken()).toBeNull();
  });

  it("refuses to swap the session of a signed-in user", async () => {
    const mod = await loadDesktopModule();
    const nonce = mod.beginDesktopOAuth();
    mod.setDesktopSessionLive(true);

    deliver(`clawbits://oauth-callback?token=attacker-session&state=${nonce}`);

    expect(storedToken()).toBeNull();
  });

  it("still accepts a sign-in after a session expires", async () => {
    // Regression guard: the stored token is only cleared on an explicit
    // logout, so it outlives its own session. Gating the deep link on its
    // presence — rather than on live auth state — would lock a user out of
    // signing back in.
    const mod = await loadDesktopModule();
    window.localStorage.setItem(AUTH_TOKEN_KEY, "stale-expired-token");
    mod.setDesktopSessionLive(false);
    const nonce = mod.beginDesktopOAuth();

    deliver(`clawbits://oauth-callback?token=fresh-token&state=${nonce}`);

    expect(storedToken()).toBe("fresh-token");
  });

  it("ignores a pending nonce older than the server's state window", async () => {
    const mod = await loadDesktopModule();
    const nonce = mod.beginDesktopOAuth();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60_000);
    try {
      deliver(`clawbits://oauth-callback?token=late-token&state=${nonce}`);
    } finally {
      vi.useRealTimers();
    }

    expect(storedToken()).toBeNull();
  });

  it("ignores deep links on schemes we do not own", async () => {
    const mod = await loadDesktopModule();
    const nonce = mod.beginDesktopOAuth();

    deliver(`evil://oauth-callback?token=attacker-session&state=${nonce}`);

    expect(storedToken()).toBeNull();
  });
});
