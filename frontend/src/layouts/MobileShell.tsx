import { lazy, Suspense, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { PageHeaderSlotProvider } from "@/components/PageHeader";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { MobileChannelInfoDrawer } from "@/components/MobileChannelInfoDrawer";
import { MobilePinnedDrawer } from "@/components/MobilePinnedDrawer";
import { isPushedMobileRoute } from "@/lib/navSections";
import type { ChannelOutletContext, ChannelPanel } from "./AppShell";

const MobileAttachmentsDrawer = lazy(() =>
  import("@/components/MobileAttachmentsDrawer").then((module) => ({ default: module.MobileAttachmentsDrawer })),
);

/** An edge-to-edge stack pinned to the visual viewport: a floating glass top bar the page header portals into,
 *  the routed screen, the floating bottom nav, and the channel bottom sheets. */
export function MobileShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [rightPanel, setRightPanel] = useState<ChannelPanel | null>(null);
  const setPanelOpen = (panel: ChannelPanel) => (open: boolean) => { setRightPanel(open ? panel : null); };

  const activeChannelId = /^\/channels\/([^/]+)/.exec(pathname)?.[1] ?? null;

  const [sheetChannelId, setSheetChannelId] = useState(activeChannelId);
  if (activeChannelId !== sheetChannelId) {
    setSheetChannelId(activeChannelId);
    if (rightPanel !== null) setRightPanel(null);
  }

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-mobile-shell", "");
    return () => {
      root.removeAttribute("data-mobile-shell");
    };
  }, []);

  return (
    // top follows visualViewport.offsetTop: iOS pans the visual viewport down under the keyboard while fixed boxes stay put.
    <div className="fixed inset-x-0 top-[var(--vv-offset-top)] flex h-[var(--vvh)] w-full flex-col overflow-hidden bg-background">
      <PageHeaderSlotProvider value={headerSlot}>
        {activeChannelId ? (
          <main className="flex min-h-0 w-full flex-1 flex-col">
            <Outlet
              context={
                {
                  panel: rightPanel,
                  togglePanel: (panel) => { setRightPanel((p) => (p === panel ? null : panel)); },
                } satisfies ChannelOutletContext
              }
            />
          </main>
        ) : (
          <main className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-content px-3 pt-[calc(var(--safe-top)+4rem)] pb-[calc(var(--bottom-nav-h)+max(0.75rem,var(--safe-bottom))+0.75rem)]">
              <Outlet />
            </div>
          </main>
        )}
      </PageHeaderSlotProvider>

      <header className="pointer-events-none absolute inset-x-0 top-0 z-30 px-3 pt-[calc(var(--safe-top)+0.5rem)]">
        <div
          data-glass
          className="pointer-events-auto mx-auto flex h-12 w-full max-w-content items-center gap-1 rounded-3xl border border-border/40 bg-background/70 px-1.5 shadow-lg ring-1 ring-foreground/[0.04] backdrop-blur-xl backdrop-saturate-150 supports-backdrop-filter:bg-background/55"
        >
          {isPushedMobileRoute(pathname) && (
            <button
              type="button"
              aria-label="Back"
              onClick={() => {
                void navigate(-1);
              }}
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition active:scale-90 active:bg-foreground/5"
            >
              <Icon icon={ArrowLeft01Icon} className="size-[22px]" />
            </button>
          )}
          <div
            ref={setHeaderSlot}
            className="flex h-full min-w-0 flex-1 items-center justify-between gap-2 px-1.5"
          />
        </div>
      </header>

      <MobileBottomNav />

      {activeChannelId && (
        <>
          <MobileChannelInfoDrawer channelId={activeChannelId} open={rightPanel === "info"} onOpenChange={setPanelOpen("info")} />
          <Suspense fallback={null}>
            <MobileAttachmentsDrawer
              channelId={activeChannelId}
              open={rightPanel === "attachments"}
              onOpenChange={setPanelOpen("attachments")}
            />
          </Suspense>
          <MobilePinnedDrawer channelId={activeChannelId} open={rightPanel === "pinned"} onOpenChange={setPanelOpen("pinned")} />
        </>
      )}
    </div>
  );
}
