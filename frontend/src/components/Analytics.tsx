import { useEffect } from "react";

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
 * ships the same `websiteId`), so that a landing pageview and the signup that
 * follows it belong to the same funnel instead of two dashboards that each show
 * the other as a dead end. Hostname is recorded per event, so the two are still
 * separable after the fact.
 *
 * Both hosts are listed rather than swapping one for the other at the Phase 6
 * apex cutover (LANDING_SITE_PLAN §8, table row 8). The app is on `clawbits.ai`
 * until the flip and on `app.clawbits.ai` after it, and the apex becomes the
 * marketing site the same day - so the union is never true of two live app
 * origins at once, and this file does not have to ship in lockstep with a DNS
 * change to avoid a gap in the numbers.
 */
const ANALYTICS_HOSTS = ["clawbits.ai", "app.clawbits.ai"];
const UMAMI_WEBSITE_ID = "3b3f10a0-3d8a-4196-b692-1442deded2d9";

export function Analytics() {
  useEffect(() => {
    if (!ANALYTICS_HOSTS.includes(location.hostname)) return;
    if (document.querySelector("script[data-clawbits-analytics]")) return;
    const s = document.createElement("script");
    s.defer = true;
    s.src = "https://cloud.umami.is/script.js";
    s.dataset.websiteId = UMAMI_WEBSITE_ID;
    s.dataset.domains = ANALYTICS_HOSTS.join(",");
    s.dataset.clawbitsAnalytics = "1";
    document.head.appendChild(s);
  }, []);
  return null;
}
