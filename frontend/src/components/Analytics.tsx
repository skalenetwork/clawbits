import { useEffect } from "react";

import { BEFORE_SEND, beforeSendPayload } from "../lib/analytics";

/**
 * Loads the Umami analytics script on mount, exactly once per page load.
 *
 * The frontend ships ONE static build for every environment (prod, staging,
 * dev, desktop) — only the live hostname differs — so we gate on
 * `location.hostname` at runtime rather than a build-time flag. A `VITE_*`
 * flag is baked identically into the shared bundle (it can't even tell
 * staging from prod) and silently disables tracking everywhere if it's ever
 * unset, which is exactly what happened before. The hostname gate also keeps
 * the third-party script off staging, dev, and the desktop (Tauri) build,
 * where its host isn't in the allowlist.
 *
 * `ANALYTICS_HOSTS` is the single source of truth: it drives both the load
 * decision here and Umami's own `data-domains` filter. To track a new host
 * (e.g. `www.`), add it here once.
 *
 * ONE Umami website spans the app AND the marketing site (web/src/config.ts
 * ships the same `websiteId`), so both properties report into one dashboard and
 * `hostname` separates them on demand. What that does NOT buy is a shared
 * session: Umami hashes the hostname into its session id, so a landing visit
 * and the app visit after it are two sessions no matter what. The hop is
 * carried by the utm campaign on the landing CTAs instead, which is why
 * `beforeSendPayload` preserves `utm_*` while dropping everything else.
 *
 * The list is only `app.clawbits.ai` since the apex cutover on 2026-08-12.
 * `clawbits.ai` was here so the app kept reporting on the day the DNS flipped
 * without a lockstep deploy; the apex is the marketing site now, and it carries
 * its own tag - leaving it here would claim an origin this build never serves.
 */
const ANALYTICS_HOSTS = ["app.clawbits.ai"];
const UMAMI_WEBSITE_ID = "3b3f10a0-3d8a-4196-b692-1442deded2d9";

export function Analytics() {
  useEffect(() => {
    if (!ANALYTICS_HOSTS.includes(location.hostname)) return;
    if (document.querySelector("script[data-clawbits-analytics]")) return;
    /* Installed BEFORE the script is appended. The tracker reads
     * `window[data-before-send]` at send time and simply skips the hook if the
     * name resolves to nothing, so losing this race would not throw - it would
     * quietly ship the raw URLs this exists to strip. */
    window[BEFORE_SEND] = beforeSendPayload;

    const s = document.createElement("script");
    s.defer = true;
    s.src = "https://cloud.umami.is/script.js";
    s.dataset.websiteId = UMAMI_WEBSITE_ID;
    s.dataset.domains = ANALYTICS_HOSTS.join(",");
    s.dataset.beforeSend = BEFORE_SEND;
    s.dataset.clawbitsAnalytics = "1";
    document.head.appendChild(s);
  }, []);
  return null;
}
