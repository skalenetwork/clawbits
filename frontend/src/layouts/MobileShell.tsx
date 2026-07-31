import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { PageHeaderSlotProvider } from "@/components/PageHeader";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { MobileChannelInfoDrawer } from "@/components/MobileChannelInfoDrawer";
import { MobileAttachmentsDrawer } from "@/components/MobileAttachmentsDrawer";
import { isPushedMobileRoute } from "@/lib/navSections";
import type { ChannelOutletContext } from "./AppShell";

/**
 * The mobile app shell: an edge-to-edge, full-height stack sized to the VISUAL
 * viewport (``--vvh``, published by useViewportVars) so it rides above the
 * on-screen keyboard instead of being covered by it. No rail, no contextual
 * sidebar, no content card — just a slim top bar, the routed screen, and the
 * floating bottom nav.
 *
 * The top bar reuses the existing PageHeader portal: every page already renders
 * ``<PageHeader/>``, so its title + actions flow into this bar with no per-page
 * changes. On "pushed" routes (a channel or agent profile) we prepend a back
 * chevron and the bottom nav hides itself (full-screen conversation/detail).
 *
 * Channel routes get the outlet context that drives ChannelPage's header pills
 * (channel info + attachments). A single ``rightPanel`` enum keeps the two
 * bottom sheets mutually exclusive, mirroring the desktop shell.
 */
export function MobileShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [rightPanel, setRightPanel] = useState<"info" | "attachments" | null>(null);
  const chatInfoOpen = rightPanel === "info";
  const attachmentsOpen = rightPanel === "attachments";

  const channelMatch = /^\/channels\/([^/]+)/.exec(location.pathname);
  const activeChannelId = channelMatch?.[1] ?? null;
  const isChannel = activeChannelId !== null;
  const pushed = isPushedMobileRoute(location.pathname);

  // Close the members sheet whenever the channel changes (or we leave the
  // channel view) so it never re-opens stale on the next conversation. Done at
  // render time — React's recommended "reset state on prop change" pattern,
  // which avoids the cascading re-render of a setState-in-effect.
  const [sheetChannelId, setSheetChannelId] = useState(activeChannelId);
  if (activeChannelId !== sheetChannelId) {
    setSheetChannelId(activeChannelId);
    if (rightPanel !== null) setRightPanel(null);
  }

  // Mark the document as "mobile shell mounted" so index.css can scope its
  // mobile rules (the document scroll-lock + shell background) to this state
  // only — desktop, Tauri, and the public/login routes (not in this shell) keep
  // their normal behavior. The document is locked because this shell is a
  // fixed-viewport box (height = --vvh); inner regions scroll, and the keyboard
  // is handled by the shell shrinking with --vvh, not by per-element offsets.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-mobile-shell", "");
    return () => {
      root.removeAttribute("data-mobile-shell");
    };
  }, []);

  return (
    // Fixed-viewport shell: a box pinned to the VISIBLE area. height = --vvh
    // (visualViewport.height) and top = --vv-offset-top (visualViewport.offsetTop)
    // — both published by useViewportVars — so it tracks the visual viewport
    // exactly. The top offset matters when the keyboard opens: iOS pans the
    // visual viewport DOWN (offsetTop > 0) while position:fixed stays anchored to
    // the layout viewport, so without this the shell would sit offsetTop px ABOVE
    // the visible area (measured on-device: top -337 with the keyboard up). It
    // does not scroll — inner regions do — so the chrome (header, nav, composer)
    // is rock-stable, and position:fixed makes it the containing block for the
    // absolute header/nav. (iOS toolbars don't retract here; the PWA has none.)
    <div className="fixed inset-x-0 top-[var(--vv-offset-top)] flex h-[var(--vvh)] w-full flex-col overflow-hidden bg-background">
      {/* Content scrolls UNDER the floating glass top bar and the floating nav
          (iOS 26 style). Non-channel pages reserve top space for the bar and
          bottom space for the nav; the channel view manages its own (the
          message list's safe-area-aware top padding + the fixed composer).
          ``pt`` = safe-top + bar lift (0.5rem) + bar height (3rem) + gap. */}
      <PageHeaderSlotProvider value={headerSlot}>
        {isChannel ? (
          // Channel fills the shell; ChannelPage's column owns the inner scroll
          // and the absolute composer. flex-1 + min-h-0 give it a bounded height.
          <main className="flex min-h-0 w-full flex-1 flex-col">
            <Outlet
              context={
                {
                  chatInfoOpen,
                  toggleChatInfo: () => {
                    setRightPanel((p) => (p === "info" ? null : "info"));
                  },
                  attachmentsOpen,
                  toggleAttachments: () => {
                    setRightPanel((p) => (p === "attachments" ? null : "attachments"));
                  },
                } satisfies ChannelOutletContext
              }
            />
          </main>
        ) : (
          // List pages: THIS element is the scroller (the document no longer
          // scrolls). Padding clears the floating header (top) and nav (bottom).
          <main className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-content px-3 pt-[calc(var(--safe-top)+4rem)] pb-[calc(var(--bottom-nav-h)+max(0.75rem,var(--safe-bottom))+0.75rem)]">
              <Outlet />
            </div>
          </main>
        )}
      </PageHeaderSlotProvider>

      {/* Floating glass top bar (iOS 26 / macOS style) — a rounded, inset glass
          capsule the content scrolls beneath, NOT a full-width/height section.
          It floats below the status-bar safe area (content goes edge-to-edge
          under the status bar); the outer wrapper is pointer-events-none so taps
          fall through its margins. PageHeader portals each page's title +
          actions into the slot; a back chevron prepends on pushed routes. */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-30 px-3 pt-[calc(var(--safe-top)+0.5rem)]">
        <div
          data-glass
          className="pointer-events-auto mx-auto flex h-12 w-full max-w-content items-center gap-1 rounded-3xl border border-border/40 bg-background/70 px-1.5 shadow-lg ring-1 ring-foreground/[0.04] backdrop-blur-xl backdrop-saturate-150 supports-backdrop-filter:bg-background/55"
        >
          {pushed && (
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

      {isChannel && activeChannelId && (
        <>
          <MobileChannelInfoDrawer
            channelId={activeChannelId}
            open={chatInfoOpen}
            onOpenChange={(o) => { setRightPanel(o ? "info" : null); }}
          />
          <MobileAttachmentsDrawer
            channelId={activeChannelId}
            open={attachmentsOpen}
            onOpenChange={(o) => { setRightPanel(o ? "attachments" : null); }}
          />
        </>
      )}
    </div>
  );
}
