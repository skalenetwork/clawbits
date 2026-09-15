import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Icon } from "@/components/Icon";
import { isDesktop } from "@/lib/desktop";
import { useAuth } from "@/context/AuthContext";

const NAV_BUTTON_CLASS =
  "flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground active:bg-foreground/15 [-webkit-app-region:no-drag]";

/** A window-wide drag strip, plus back and forward past the traffic lights once signed in (the auth flow has no
 *  history worth traversing). */
export function DesktopTitleBar() {
  const navigate = useNavigate();
  const { user } = useAuth();
  if (!isDesktop) return null;
  return (
    <>
      <div
        aria-hidden="true"
        data-tauri-drag-region
        className="fixed inset-x-0 top-0 z-40 h-10 [-webkit-app-region:drag]"
      />
      {user && (
        <div className="fixed left-4 top-1.5 z-50 flex h-7 select-none items-center gap-0.5 pl-[var(--titlebar-traffic-clearance)] [-webkit-app-region:drag]">
          <button
            type="button"
            onClick={() => { void navigate(-1); }}
            title="Back (⌘[)"
            aria-label="Go back"
            className={`ml-2 ${NAV_BUTTON_CLASS}`}
          >
            <Icon icon={ArrowLeft} className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => { void navigate(1); }}
            title="Forward (⌘])"
            aria-label="Go forward"
            className={NAV_BUTTON_CLASS}
          >
            <Icon icon={ArrowRight} className="size-4" />
          </button>
        </div>
      )}
    </>
  );
}
