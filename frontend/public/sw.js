/*
 * Clawbits push-only service worker.
 *
 * Deliberately minimal: it handles the Web Push `push` and `notificationclick`
 * events and nothing else. No fetch interception, no asset caching — this is
 * NOT a full offline PWA service worker, just the piece the Push API requires
 * to deliver a notification when the tab is closed. Keeping it cache-free
 * avoids the classic stale-asset footguns.
 *
 * It is registered only on the web (never inside the Tauri desktop shell,
 * which uses its own native notifications + SSE). See src/lib/push.ts.
 *
 * Served from /sw.js (Vite copies public/ verbatim; FastAPI's SPA static
 * handler serves it in production), giving it root scope so a push can wake
 * it regardless of which route the user last had open.
 */

// Activate a new version immediately rather than waiting for all tabs to
// close — there are no caches to migrate, so it's always safe.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * A push arrived. Show a notification — UNLESS a Clawbits tab is currently
 * focused, in which case the in-app SSE stream has already surfaced the
 * message and a banner would be redundant noise. This mirrors the desktop
 * app's `document.hasFocus()` gate.
 */
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Clawbits", body: event.data.text() };
  }

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Suppress only when a tab is actually focused (not merely visible) —
      // the user is looking at the app, so SSE handled it.
      const focused = windows.some((c) => c.focused === true);
      if (focused) return;

      const tag = payload.tag || undefined;
      await self.registration.showNotification(payload.title || "Clawbits", {
        body: payload.body || "",
        tag,
        // With a per-channel tag, a newer message replaces the older banner;
        // renotify makes that replacement re-alert instead of silently swapping.
        renotify: Boolean(tag),
        icon: "/favicon.png",
        badge: "/favicon.png",
        timestamp: Date.now(),
        data: { url: payload.url || "/", channelId: payload.channelId || null },
      });
    })(),
  );
});

/**
 * The user clicked a notification. Focus an existing Clawbits tab and ask the
 * app to route to the channel (soft nav); if no tab is open, open one at the
 * target URL (full load lands on the route). The app listens for the
 * `push-navigate` message — see src/lib/push.ts.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || "/";

  // The server sends an absolute URL on the app origin. Only a client on THAT
  // origin runs the app and can act on `push-navigate`; a same-origin tab of
  // some other site (which is what `matchAll` would hand back to a registration
  // left over on the old apex) would swallow the message and leave the user
  // staring at the page they were already on. When the target is elsewhere,
  // skip the focus path and open a window at it.
  let sameOrigin = true;
  try {
    const target = new URL(url, self.location.origin);
    sameOrigin = target.origin === self.location.origin;
  } catch {
    /* malformed — treat as a path on this origin */
  }

  event.waitUntil(
    (async () => {
      if (sameOrigin) {
        const windows = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const client of windows) {
          if ("focus" in client) {
            await client.focus();
            client.postMessage({ type: "push-navigate", url });
            return;
          }
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
