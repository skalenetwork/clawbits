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
 * (e.g. `www.` or `app.clawbits.ai`), add it here once.
 */
const ANALYTICS_HOSTS = ["clawbits.ai"];
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
