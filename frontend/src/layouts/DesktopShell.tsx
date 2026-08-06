import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import ChatInfoSidebar from "@/components/ChatInfoSidebar";
import AttachmentsSidebar from "@/components/AttachmentsSidebar";
import { useShortcut } from "@/lib/shortcuts";
import { SidebarProvider, useSidebar } from "../components/ui/sidebar";
import { AppRail } from "@/components/AppRail";
import { PageHeaderSlotProvider } from "@/components/PageHeader";
import { ChatsSidebar } from "@/components/sidebars/ChatsSidebar";
import { AgentsSidebar } from "@/components/sidebars/AgentsSidebar";
import { SettingsSidebar } from "@/components/sidebars/SettingsSidebar";
import { UpdateBanner } from "@/components/UpdateBanner";
import { WizardDockChip } from "@/components/new-agent/WizardDockChip";
import {
  deriveSection,
  sectionHasSidebar,
  type SectionId,
} from "@/lib/navSections";
import { cn } from "@/lib/utils";
import type { ChannelOutletContext } from "./AppShell";

/**
 * Registers ⌘/Ctrl+B with the central ShortcutProvider. Lives inside
 * SidebarProvider so `useSidebar()` works. Toggles the *contextual* sidebar
 * (the list pane inside the card) — the rail is always present.
 */
function SidebarShortcutBinding() {
  const { toggleSidebar } = useSidebar();
  useShortcut({
    id: "sidebar-trigger",
    keys: "$mod+b",
    run: () => {
      toggleSidebar();
    },
    hint: { label: "B", group: "Layout", description: "Toggle sidebar" },
  });
  return null;
}

/** Picks the contextual sidebar for the active section. Home is the merged
 *  chats hub, so it shows the channel/DM list. */
function ContextualSidebar({ section }: { section: SectionId }) {
  if (section === "agents") return <AgentsSidebar />;
  if (section === "settings") return <SettingsSidebar />;
  return <ChatsSidebar />;
}

const SIDEBAR_OPEN_KEY = "fc_sidebar_open";

/**
 * The desktop app shell: a thin icon rail (always present) + a single floating
 * card that holds the section's contextual sidebar and the routed content, plus
 * the right-edge ChatInfoSidebar on channel routes. This is the original
 * AppShell layout, extracted verbatim so the orchestrator can branch
 * desktop/mobile. The rail + gaps show ``--background``; the ``bg-panel``
 * surface floats on top with smaller ``bg-card`` cards a tier above inside.
 */
export function DesktopShell() {
  const location = useLocation();

  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_OPEN_KEY);
    return stored !== "false";
  });
  // Always closed at session start — the in-header pills keep them one click
  // away. Not persisted: the chat column reclaims full width each time. A
  // single enum so the two right-edge panels (channel info / attachments) are
  // mutually exclusive — opening one closes the other.
  const [rightPanel, setRightPanel] = useState<"info" | "attachments" | null>(null);
  const chatInfoOpen = rightPanel === "info";
  const attachmentsOpen = rightPanel === "attachments";
  const toggleRightPanel = (panel: "info" | "attachments") => {
    setRightPanel((cur) => (cur === panel ? null : panel));
  };
  // The content card's unified page-header bar; pages portal their title +
  // actions into this node via <PageHeader/>.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  const section = deriveSection(location.pathname);
  const showContextual = sectionHasSidebar(section);
  // Home is vertically centered, so it wants a touch less top clearance than the
  // scrolling pages (which need the full header-height gap).
  const isHome = location.pathname === "/home";

  const channelRouteMatch = /^\/channels\/([^/]+)/.exec(location.pathname);
  const activeChannelId = channelRouteMatch?.[1] ?? null;
  const isChannelRoute = activeChannelId !== null;
  // The agent inbox is a bounded-height split view (list column + reading
  // pane, each with its own scroller) — it needs the channel-style full-height
  // branch, not the scrolling max-w-content document.
  const isInboxRoute = /^\/agents\/[^/]+\/inbox/.test(location.pathname);

  const handleSidebarOpenChange = (open: boolean) => {
    setSidebarOpen(open);
    localStorage.setItem(SIDEBAR_OPEN_KEY, String(open));
  };

  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={handleSidebarOpenChange}
      className="bg-background"
    >
      <SidebarShortcutBinding />
      {/* Skip link - first focusable thing in the tree, so one Tab from a fresh
          page load jumps past the rail and the contextual sidebar straight to
          the content. Hidden off-screen until focused (see .skip-link). */}
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <AppRail activeSection={section} />

      {/* Content region — the p-2-style inset around the card. ``pt`` clears
                the macOS title-bar pill / traffic lights (0 on web). ``pl-0`` so
                the card abuts the rail: the rail's centered icons then sit with
                equal space on each side (window edge ↔ icon ↔ card). */}
      <div className="min-w-0 flex-1 pb-2 pl-0 pr-2 pt-[max(var(--titlebar-height),0.5rem)]">
        <div className="relative flex h-full overflow-hidden rounded-xl border border-sidebar-border bg-panel shadow-sm">
          {/* Contextual sidebar — the card's left pane. Desktop/tablet
                        only for now (mobile navigation lands in a later phase). */}
          {showContextual && sidebarOpen && (
            <aside className="relative hidden w-(--sidebar-width) shrink-0 flex-col border-r border-sidebar-border md:flex">
              <ContextualSidebar section={section} />
              {/* Sidebar footer: the minimized Add-Agent chip + the desktop
                                auto-update banner, floating OVER the list's
                                bottom edge - their frosted backgrounds blur
                                whatever scrolls beneath. pointer-events-none
                                here (restored per card) so the gap between
                                them never blocks a row behind it. */}
              <div className="pointer-events-none absolute inset-x-2 bottom-2 z-20 flex flex-col gap-2 empty:hidden">
                <WizardDockChip />
                <UpdateBanner />
              </div>
            </aside>
          )}

          {/* Footer fallback for when the sidebar pane is hidden (collapsed
                        via ⌘B or a sidebar-less section) - the minimized-wizard
                        chip and update banner float bottom-left over the content
                        so both stay actionable. Rendered only when the in-sidebar
                        footer above is not, so each mounts once. The wizard chip
                        frosts the content behind it (translucent + blur), so no
                        backdrop; the banner's tinted translucent background gets
                        a solid bg-card one. */}
          {!(showContextual && sidebarOpen) && (
            <div className="absolute bottom-2 left-2 z-30 flex w-(--sidebar-width) flex-col gap-2">
              <div className="rounded-xl shadow-md empty:hidden">
                <WizardDockChip />
              </div>
              <div className="rounded-xl bg-card shadow-md empty:hidden">
                <UpdateBanner />
              </div>
            </div>
          )}

          {/* Content column. */}
          <PageHeaderSlotProvider value={headerSlot}>
            <div className="relative flex min-w-0 flex-1 flex-col">
              {/* Unified page-header bar — same height + bottom border as
                                the sidebar's ContextualHeader so the two line up as one
                                header row across the card. */}
              <div className="absolute inset-x-0 top-0 z-10 h-12 border-b border-sidebar-border bg-panel/80 backdrop-blur-xl supports-[backdrop-filter]:bg-panel/65">
                {/* Header content is centered and width-capped to match the
                    body beneath it. Channel routes run the narrower chat
                    column (``max-w-chat``) so the avatar/name aligns with the
                    message column and the actions align with the composer's
                    right edge; every other page keeps ``max-w-content``. The
                    full-width border + background above stay full-bleed. */}
                <div
                  ref={setHeaderSlot}
                  className={cn(
                    "mx-auto flex h-full w-full items-center justify-between gap-2 px-3",
                    isChannelRoute ? "max-w-chat" : "max-w-content",
                  )}
                />
              </div>
              <div className="flex min-h-0 flex-1">
                <main
                  id="main-content"
                  tabIndex={-1}
                  className={`min-w-0 flex-1 overflow-y-auto outline-none ${isChannelRoute || isInboxRoute ? "" : "gutter-stable-both"}`}
                >
                  {isChannelRoute ? (
                    <div className="flex h-full w-full flex-col">
                      <Outlet
                        context={
                          {
                            chatInfoOpen,
                            toggleChatInfo: () => { toggleRightPanel("info"); },
                            attachmentsOpen,
                            toggleAttachments: () => { toggleRightPanel("attachments"); },
                          } satisfies ChannelOutletContext
                        }
                      />
                    </div>
                  ) : isInboxRoute ? (
                    // Full-bleed like channels; the page provides its own
                    // pt-12 header clearance and per-column scrollers.
                    <div className="flex h-full w-full flex-col">
                      <Outlet />
                    </div>
                  ) : (
                    <div className={cn("mx-auto flex min-h-full w-full max-w-content flex-col px-2 pb-0", isHome ? "pt-12" : "pt-16")}>
                      <Outlet />
                    </div>
                  )}
                </main>
              </div>
            </div>
          </PageHeaderSlotProvider>
        </div>
      </div>

      {/* Right-edge panels — flex siblings *outside* the content card
                (mirroring the rail on the left). Mutually exclusive via
                ``rightPanel``; both stay mounted and animate width so the chat
                column reclaims space when neither is open. */}
      {isChannelRoute && activeChannelId && (
        <>
          <ChatInfoSidebar
            channelId={activeChannelId}
            open={chatInfoOpen}
            onClose={() => { setRightPanel(null); }}
          />
          <AttachmentsSidebar
            channelId={activeChannelId}
            open={attachmentsOpen}
            onClose={() => { setRightPanel(null); }}
          />
        </>
      )}
    </SidebarProvider>
  );
}
