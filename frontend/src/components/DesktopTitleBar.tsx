import { useNavigate } from "react-router-dom";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { isDesktop } from "@/lib/desktop";
import { useAuth } from "@/context/AuthContext";

const NAV_BUTTON_CLASS =
  "flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground active:bg-foreground/15 [-webkit-app-region:no-drag]";

/**
 * Minimal macOS desktop title bar: a full-width invisible drag strip plus a
 * short top-left region that reserves space for the traffic lights and hosts
 * back / forward navigation. Returns null in browser builds.
 */
export function DesktopTitleBar() {
  const navigate = useNavigate();
  const { user } = useAuth();
  if (!isDesktop) return null;
  return (
    <>
      {/* Invisible drag strip across the full top of the window so the user
       *  can grab the window anywhere along the top edge — not just on the
       *  controls. Always present so the window stays draggable, including
       *  on the login screen where the nav buttons are hidden. */}
      <div
        aria-hidden="true"
        data-tauri-drag-region
        className="fixed inset-x-0 top-0 z-40 h-10 [-webkit-app-region:drag]"
      />
      {/* Top-left controls: traffic-light clearance + back / forward. No
       *  background: a bare drag region for the buttons only.
       *  Hidden while signed out: the login / verify-email screens have no
       *  in-app history to traverse, so the arrows would only ever bounce
       *  the user around the auth flow. */}
      {user && (
        <div
          className="
            fixed left-4 top-1.5 z-50 flex h-7 select-none items-center gap-0.5
            pl-[var(--titlebar-traffic-clearance)]
            [-webkit-app-region:drag]
          "
        >
          <button
            type="button"
            onClick={() => { void navigate(-1); }}
            title="Back (⌘[)"
            aria-label="Go back"
            className={`ml-2 ${NAV_BUTTON_CLASS}`}
          >
            <Icon icon={ArrowLeft01Icon} className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => { void navigate(1); }}
            title="Forward (⌘])"
            aria-label="Go forward"
            className={NAV_BUTTON_CLASS}
          >
            <Icon icon={ArrowRight01Icon} className="size-4" />
          </button>
        </div>
      )}
    </>
  );
}
