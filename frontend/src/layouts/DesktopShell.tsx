import { useEffect, useRef, useState } from "react";
import {FOOTER_SCRIM, HeaderScrim} from "@/components/ProgressiveBlur";
import {RailNavShortcuts} from "@/components/RailNavShortcuts";
import {isDesktop} from "@/lib/desktop";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import ChatInfoSidebar from "@/components/ChatInfoSidebar";
import AttachmentsSidebar from "@/components/AttachmentsSidebar";
import PinnedSidebar from "@/components/PinnedSidebar";
import { useShortcut } from "@/lib/shortcuts";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "../components/ui/sidebar";
import { PageHeaderSlotProvider } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { MainSidebar } from "@/components/sidebars/MainSidebar";
import { SettingsSidebar } from "@/components/sidebars/SettingsSidebar";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SETTINGS_PATH } from "@/lib/navSections";
import { SidebarToggle } from "@/components/sidebars/SidebarToggle";
import { cn } from "@/lib/utils";
import type { ChannelOutletContext, ChannelPanel } from "./AppShell";

/** Registers ⌘/Ctrl+B to toggle the sidebar; lives inside SidebarProvider. */
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

const SIDEBAR_OPEN_KEY = "fc_sidebar_open";

/**
 * The desktop shell: the sidebar and the routed content as two flat panes, plus
 * the right-edge panels on channel routes. In the desktop app the sidebar
 * reaches the window's top edge so its first row shares the title bar with the
 * traffic lights.
 */
export function DesktopShell() {
  const location = useLocation();
  const navigate = useNavigate();

  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_OPEN_KEY);
    return stored !== "false";
  });
  // Always closed at session start and not persisted, so the chat column
  // reclaims full width each time. One enum keeps the panels mutually exclusive.
  const [rightPanel, setRightPanel] = useState<ChannelPanel | null>(null);
  const chatInfoOpen = rightPanel === "info";
  const attachmentsOpen = rightPanel === "attachments";
  const pinnedOpen = rightPanel === "pinned";
  const toggle = (panel: ChannelPanel) => () => {
    setRightPanel((cur) => (cur === panel ? null : panel));
  };
  // The content column's page-header bar; pages portal their title +
  // actions into this node via <PageHeader/>.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  const inSettings = location.pathname.startsWith("/settings");
  const backTo = useRef("/home");
  useEffect(() => {
    if (!inSettings) backTo.current = location.pathname;
  }, [inSettings, location.pathname]);
  const isHome = location.pathname === "/home";

  const activeChannelId = /^\/channels\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
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
          page load jumps past the sidebar straight to the content. Hidden
          off-screen until focused (see .skip-link). */}
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {/* Two flat panes, edge to edge. The fill difference is the only
          separation: no hairline, nothing inset, rounded or raised. */}
      <div className="relative flex min-w-0 flex-1 overflow-hidden pt-(--titlebar-height)">
        {sidebarOpen && (
          <aside data-vt-contextual="" className="relative z-[45] -mt-(--titlebar-height) hidden w-(--sidebar-width) shrink-0 flex-col bg-sidebar md:flex">
            {isDesktop && (
              <div
                data-tauri-drag-region
                className="flex h-(--titlebar-height) shrink-0 items-center justify-end pr-2 [-webkit-app-region:drag]"
              >
                <SidebarToggle />
              </div>
            )}
            <div className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-2">
              {inSettings ? <SettingsSidebar /> : <MainSidebar />}
              <div className={cn(FOOTER_SCRIM, "flex flex-col gap-2")}>
                <UpdateBanner />
                {inSettings ? (
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        onClick={() => {
                          void navigate(backTo.current);
                        }}
                        className="text-muted-foreground"
                      >
                        <ArrowLeft />
                        <span>Back</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                ) : (
                  <div className="flex items-center gap-1">
                    <OrgSwitcher />
                    <NavLink
                      to={SETTINGS_PATH}
                      title="Settings"
                      aria-label="Settings"
                      className="grid size-[34px] shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--sb-hover)] hover:text-sidebar-foreground"
                    >
                      <Icon icon={Settings01Icon} className="size-4" />
                    </NavLink>
                  </div>
                )}
              </div>
            </div>
          </aside>
        )}

        {/* With the sidebar collapsed (⌘B) the update banner floats bottom-left
            over the content so it stays actionable, on a solid bg-card
            backdrop behind its translucent tint. */}
        {!sidebarOpen && (
          <div className="absolute bottom-2 left-2 z-30 w-(--sidebar-width) rounded-xl bg-card shadow-md empty:hidden">
            <UpdateBanner />
          </div>
        )}

        <PageHeaderSlotProvider value={headerSlot}>
          <div className="relative flex min-w-0 flex-1 flex-col">
            {/* Pages portal their title and actions into this bar. Home has
                neither, so there it only appears to hold the sidebar toggle. */}
            {(!isHome || !sidebarOpen) && (
              <div className="absolute inset-x-0 top-0 z-10 flex h-12 items-center gap-2 px-3">
                <HeaderScrim color="background"/>
                {!sidebarOpen && <SidebarToggle />}
                <div ref={setHeaderSlot} className="flex h-full min-w-0 flex-1 items-center justify-between gap-2" />
              </div>
            )}
            <div className="flex min-h-0 flex-1">
              <main
                id="main-content"
                tabIndex={-1}
                className={`min-w-0 flex-1 overflow-y-auto outline-none ${activeChannelId || isInboxRoute ? "" : "gutter-stable-both"}`}
              >
                {activeChannelId ? (
                  <div className="flex h-full w-full flex-col">
                    <Outlet
                      context={
                        {
                          chatInfoOpen,
                          toggleChatInfo: toggle("info"),
                          attachmentsOpen,
                          toggleAttachments: toggle("attachments"),
                          pinnedOpen,
                          togglePinned: toggle("pinned"),
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
                  <div className={cn("mx-auto flex min-h-full w-full max-w-content flex-col px-2 pb-0", isHome ? "" : "pt-16")}>
                    <Outlet />
                  </div>
                )}
              </main>
            </div>
          </div>
        </PageHeaderSlotProvider>
      </div>

      {isDesktop && <RailNavShortcuts/>}
      {/* Right-edge panels, flex siblings of the panes; all stay mounted and
          animate width so the chat column reclaims space when none is open. */}
      {activeChannelId && (
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
          <PinnedSidebar
            channelId={activeChannelId}
            open={pinnedOpen}
            onClose={() => { setRightPanel(null); }}
          />
        </>
      )}
    </SidebarProvider>
  );
}
