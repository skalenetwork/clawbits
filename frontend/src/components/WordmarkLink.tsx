import { isDesktop, openExternal } from "@/lib/desktop";

/**
 * The marketing site. Mirrors web/src/config.ts's APP_URL pointing back here:
 * the apex is the landing page and app.* is this app, from the Phase 6 cutover
 * onward (docs/protocol/LANDING_SITE_PLAN.md §8). Before the DNS flip the apex
 * still serves this app, so the wordmark round-trips instead of leaving - it
 * starts behaving correctly on the day the flip happens, with no code change.
 */
export const MARKETING_URL = "https://clawbits.ai";

/**
 * The wordmark, as a way back out to the marketing site.
 *
 * A plain anchor on web, so it behaves like a link - same-tab navigation,
 * middle-click, copy-link. On desktop it must NOT be one: a Tauri WebView
 * would navigate the app window itself to clawbits.ai and strand the user
 * outside the app with no back button, so there we hand the URL to the OS.
 *
 * Lives here rather than inside LoginPage because both halves of the auth
 * funnel (/login and /verify-email) put it on the same dark canvas, and a
 * second copy is how the two screens drifted apart in the first place.
 */
export function WordmarkLink({ className }: { className?: string }) {
  return (
    <a
      href={MARKETING_URL}
      onClick={
        isDesktop
          ? (e) => {
              e.preventDefault();
              void openExternal(MARKETING_URL);
            }
          : undefined
      }
      className="inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
    >
      <img src="/clawbits-long.svg" alt="Clawbits home" className={className} />
    </a>
  );
}

export default WordmarkLink;
