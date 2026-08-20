/**
 * Web Push (browser notifications) client.
 *
 * Pairs with the push-only service worker at /sw.js and the backend
 * /api/push/* endpoints. The flow: register the SW → fetch the server's
 * VAPID public key → request Notification permission → subscribe via the
 * Push API → POST the subscription so the dispatcher can reach this browser
 * when no tab is focused.
 *
 * Everything here is a no-op inside the Tauri desktop shell (`isDesktop`),
 * which uses native notifications + SSE instead, and on browsers/contexts
 * that don't support the Push API or aren't secure (HTTPS / localhost).
 */
import { useCallback, useEffect, useState } from "react";

import { getVapidPublicKey, subscribeWebPush, unsubscribeWebPush } from "@/lib/api";
import { isDesktop } from "@/lib/desktop";

const SW_URL = "/sw.js";

// Cache the registration so repeat calls (enable, refresh, click-nav) don't
// each hit navigator.serviceWorker.register.
let registration: ServiceWorkerRegistration | null = null;

/** Whether this runtime can do web push at all. */
export function isPushSupported(): boolean {
  return (
    !isDesktop &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}

/** True when running as an installed PWA (standalone display) rather than a
 *  regular browser tab. iOS exposes this via the non-standard
 *  ``navigator.standalone``; every other engine via the display-mode query.
 *  This is the gate that matters on iOS — web push only works in the
 *  Home-Screen app, never in a Safari tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  // iOS Safari's non-standard flag — the only signal on older iOS.
  return Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
}

/** True on iPhone / iPad — including iPadOS 13+, which reports itself as a Mac
 *  but has a touch screen. Used to explain that notifications need the app
 *  added to the Home Screen rather than claiming the browser can't do push. */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as desktop Safari on a Mac but still exposes touch.
  return ua.includes("Macintosh") && navigator.maxTouchPoints > 1;
}

/** Register the push service worker (idempotent). Returns null when push
 *  isn't supported or registration fails. */
export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  if (registration) return registration;
  try {
    registration = await navigator.serviceWorker.register(SW_URL);
    return registration;
  } catch (err) {
    console.warn("[push] service worker registration failed", err);
    return null;
  }
}

// The VAPID applicationServerKey must be passed to pushManager.subscribe as a
// Uint8Array, not the base64url string.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Back the view with a concrete ArrayBuffer (not ArrayBufferLike) so it
  // satisfies pushManager.subscribe's BufferSource param under TS 5.7+.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function getExistingSubscription(): Promise<PushSubscription | null> {
  const reg = await registerPushServiceWorker();
  if (!reg) return null;
  return (await reg.pushManager.getSubscription()) ?? null;
}

export type EnableResult = "enabled" | "denied" | "unsupported" | "unavailable";

/** Full opt-in: permission prompt → subscribe → persist server-side. */
export async function enablePush(): Promise<EnableResult> {
  const reg = await registerPushServiceWorker();
  if (!reg) return "unsupported";

  let key: string | null;
  try {
    key = await getVapidPublicKey();
  } catch {
    return "unavailable";
  }
  if (!key) return "unavailable";

  if (Notification.permission === "denied") return "denied";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  await subscribeWebPush(sub.toJSON());
  return "enabled";
}

/** Opt-out: unsubscribe in the browser and drop the server-side row. */
export async function disablePush(): Promise<void> {
  const sub = await getExistingSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  try {
    await sub.unsubscribe();
  } catch {
    /* ignore — still drop it server-side below */
  }
  try {
    await unsubscribeWebPush(endpoint);
  } catch {
    /* ignore — best effort */
  }
}

/** For users who already granted permission, re-assert the SW + server row on
 *  app load. Cheap and idempotent; keeps the stored endpoint fresh after the
 *  browser silently rotates it. No-op otherwise. */
export async function refreshPushOnLoad(): Promise<void> {
  if (!isPushSupported() || Notification.permission !== "granted") return;
  try {
    const sub = await getExistingSubscription();
    if (sub) await subscribeWebPush(sub.toJSON());
  } catch {
    /* best effort */
  }
}

/** Fold a push payload's target into something react-router can navigate to.
 *
 *  The server sends an ABSOLUTE URL on the app origin (so a service worker
 *  registered on the old apex still opens the right host — see the backend's
 *  ``_build_payload``). react-router treats its argument as a path, so
 *  ``navigate("https://app.clawbits.ai/channels/x")`` would route to a garbage
 *  path. Strip the origin when it is ours; return null for a genuinely
 *  cross-origin URL so the caller can hard-navigate instead of soft-routing
 *  somewhere it doesn't belong. Bare paths pass through unchanged. */
export function pushTargetToPath(raw: string): string | null {
  if (raw.startsWith("/")) return raw;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** Soft-navigate when the service worker reports a notification click. The SW
 *  posts ``{type:"push-navigate", url}`` to the focused client. Returns a
 *  cleanup fn. No-op on desktop / unsupported. */
export function setupPushClickNavigation(navigate: (url: string) => void): () => void {
  if (isDesktop || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return () => {};
  }
  const handler = (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type === "push-navigate" && typeof data.url === "string") {
      const path = pushTargetToPath(data.url);
      if (path) navigate(path);
      else window.location.assign(data.url);
    }
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => {
    navigator.serviceWorker.removeEventListener("message", handler);
  };
}

export type PushUiStatus =
  | "loading"
  | "unsupported"
  /** iOS in a Safari tab — push is possible, but only once the app is added
   *  to the Home Screen. Fixable by the user, so surfaced distinctly from
   *  "unsupported". */
  | "install-required"
  | "unavailable"
  | "prompt"
  | "denied"
  | "enabled";

/** Settings-screen state machine for the enable/disable control. */
export function usePushSubscription(): {
  status: PushUiStatus;
  busy: boolean;
  enable: () => Promise<EnableResult>;
  disable: () => Promise<void>;
} {
  const [status, setStatus] = useState<PushUiStatus>("loading");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!isPushSupported()) {
      // On iOS the Push API only exists inside the Home-Screen app, so a
      // Safari tab reports unsupported even though the user *can* enable it by
      // installing. Flag that case separately so the UI can guide them.
      setStatus(isIOS() && !isStandalone() ? "install-required" : "unsupported");
      return;
    }
    let key: string | null = null;
    try {
      key = await getVapidPublicKey();
    } catch {
      /* treated as unavailable below */
    }
    if (!key) {
      setStatus("unavailable");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    const sub = await getExistingSubscription();
    setStatus(sub ? "enabled" : "prompt");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = useCallback(async (): Promise<EnableResult> => {
    setBusy(true);
    try {
      const result = await enablePush();
      await refresh();
      return result;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await disablePush();
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return { status, busy, enable, disable };
}
